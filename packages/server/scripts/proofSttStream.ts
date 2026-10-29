/**
 * proofSttStream.ts — the streaming ear, measured against the real provider.
 *
 * This is the evidence for the slice, not a demo. It runs ONE Portuguese
 * question through the door's ACTUAL stack and prints, from the last voiced
 * frame:
 *
 *   A) STREAM (the new path)
 *      page -> relay (WS, our server) -> Deepgram nova-3 streaming
 *      end of turn = the provider's endpointing (`speech_final`), not a timer.
 *      Every stage is measured with the page's own clock: the provider's
 *      `words[].end` is mapped onto `performance.now()` through the audio clock
 *      the client keeps while sending.
 *
 *   B) BATCH (the path it replaces)
 *      local VAD waits 1200 ms of silence -> 16 kHz WAV -> POST /v1/listen.
 *      The 1200 ms is not a guess: it is `VAD_DEFAULTS.endSilenceMs`, the number
 *      the door currently ships.
 *
 * The audio is the door's real voice (Deepgram TTS, Mariana, pt-BR) asking a real
 * door question, so the transcript is what a visitor would actually say. It is
 * fed to the socket in 100 ms blocks, paced in real time, with 1.6 s of room
 * silence after it — exactly what the microphone hands the page.
 *
 * Nothing here boots the shared kiosk: the relay binds an ephemeral port.
 *
 *   cd packages/server && npx ts-node --transpile-only scripts/proofSttStream.ts
 *   ... --text="qual é o briefing da casa?"   (override the question)
 *   ... --endpointing=400                      (measure a different window)
 */

import fs from 'fs';
import os from 'os';
import http from 'http';
import path from 'path';
import { performance } from 'perf_hooks';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { attachCoexistirSttStream, STT_STREAM_PATH } from '../routes/coexistirVoiceStream';
import { createPortalSttStream, type SttStreamTurnEvent } from '../../client/src/portal/portalSttStream';
import { transcribeAudio, encodeWavForProof } from './proofSttStream.helpers';
import { VAD_DEFAULTS } from '../../client/src/portal/portalVad';

const ROOT = path.resolve(__dirname, '../../..');

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

function readEnvKey(): string {
  if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY;
  for (const file of [
    path.join(ROOT, '.env'),
    path.join(ROOT, 'packages/castalia/.env'),
    'C:/flur_workspace/packages/castalia/.env',
  ]) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const match = raw.match(/^\s*DEEPGRAM_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
      if (match) return match[1].trim();
    } catch {
      /* next candidate */
    }
  }
  return '';
}

interface Wav {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

/** Minimal RIFF reader: enough for a Deepgram TTS response. */
function parseWav(buffer: Buffer): Wav {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE body');
  }
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`unsupported bit depth ${bits}`);
      const raw = buffer.subarray(body, Math.min(buffer.length, body + size));
      // Copy into an aligned buffer: a subarray of an odd offset is not a valid
      // Int16Array view on every platform.
      const copy = Buffer.from(raw);
      return { pcm: new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2)), sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** Say one sentence with the door's own voice, at the rate the page sends. */
async function synthesise(text: string, apiKey: string): Promise<Wav> {
  const url =
    'https://api.deepgram.com/v2/speak?model=flux-mariana-pt&encoding=linear16&sample_rate=16000&container=wav';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseWav(Buffer.from(await res.arrayBuffer()));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StreamResult {
  text: string;
  by: 'speech_final' | 'utterance_end';
  sttMsServer: number;
  /** Page clock: first audio pushed to the socket. */
  epoch: number;
  /** Page clock: the provider's last word, mapped through the audio clock. */
  lastWordEndPerf: number | null;
  /** Page clock: the turn arrived. */
  turnAt: number;
  /** Last word -> turn. The number this slice exists to shrink. */
  fromLastWord: number;
  /** End of the spoken clip -> turn (includes endpointing). */
  fromClipEnd: number;
  frames: Array<{ at: number; kind: string; detail: string }>;
}

async function runStream(
  wav: Wav,
  apiKey: string,
  port: number,
): Promise<StreamResult> {
  const frames: StreamResult['frames'] = [];
  const samplesPerBlock = 1600; // 100 ms at 16 kHz
  const silenceBlocks = 16; // 1.6 s of room after the question

  let resolveTurn: ((turn: SttStreamTurnEvent) => void) | null = null;
  const turnPromise = new Promise<SttStreamTurnEvent>((resolve) => {
    resolveTurn = resolve;
  });

  const client = createPortalSttStream({
    url: `ws://127.0.0.1:${port}${STT_STREAM_PATH}?room=coexistir&language=auto`,
    inputRate: wav.sampleRate,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    now: () => performance.now(),
    onReady: (info) =>
      frames.push({
        at: performance.now(),
        kind: 'ready',
        detail: `endpointing=${info.endpointing} utterance_end=${info.utteranceEndMs} model=${info.model}`,
      }),
    onInterim: (text) => frames.push({ at: performance.now(), kind: 'interim', detail: text }),
    onFinal: (event) =>
      frames.push({
        at: performance.now(),
        kind: 'final',
        detail: `"${event.text}"${event.speechFinal ? ' speech_final' : ''} audio=${event.audioMs}ms`,
      }),
    onTurn: (turn) => resolveTurn?.(turn),
    onError: (code, message) => frames.push({ at: performance.now(), kind: 'error', detail: `${code}: ${message}` }),
    onClose: (reason) => frames.push({ at: performance.now(), kind: 'closed', detail: reason }),
  });

  const ready = await client.connect();
  if (!ready) throw new Error('relay never became ready');

  let epoch = 0;
  const blockMs = 100;
  const speechBlocks = Math.ceil(wav.pcm.length / samplesPerBlock);
  const totalBlocks = speechBlocks + silenceBlocks;
  for (let block = 0; block < totalBlocks; block += 1) {
    const start = block * samplesPerBlock;
    // ALWAYS a full block: past the end of the clip this is room tone, and the
    // provider needs that silence to endpoint. Sending nothing is not silence —
    // it is a stalled socket, and the turn never closes.
    const float = new Float32Array(samplesPerBlock);
    const end = Math.min(wav.pcm.length, start + samplesPerBlock);
    for (let i = start; i < end; i += 1) float[i - start] = wav.pcm[i] / 32768;
    const at = performance.now();
    if (block === 0) epoch = at;
    client.send(float, at, wav.sampleRate);
    // Pace to the audio clock: block N is due N * 100 ms after the first.
    const due = epoch + (block + 1) * blockMs;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    if (block === speechBlocks - 1) {
      frames.push({ at: performance.now(), kind: 'speech-end', detail: `${client.audioMs} ms of speech sent` });
    }
  }
  frames.push({ at: performance.now(), kind: 'audio-end', detail: `${client.audioMs} ms sent (incl. room tone)` });

  const turn = await Promise.race([
    turnPromise,
    sleep(6000).then(() => {
      for (const frame of frames) {
        console.error(`  (+${Math.round(frame.at - epoch)} ms) ${frame.kind}: ${frame.detail}`);
      }
      throw new Error('no turn arrived within 6 s of the end of audio');
    }),
  ]);
  const turnAt = turn.atPerf;
  const lastWordEndPerf = turn.lastWordEndPerf;
  const clipEnd = epoch + (wav.pcm.length / wav.sampleRate) * 1000;

  client.close();

  return {
    text: turn.text,
    by: turn.by,
    sttMsServer: turn.sttMs,
    epoch,
    lastWordEndPerf,
    turnAt,
    fromLastWord: lastWordEndPerf === null ? Number.NaN : Math.round(turnAt - lastWordEndPerf),
    fromClipEnd: Math.round(turnAt - clipEnd),
    frames,
  };
}

async function runBatch(wav: Wav, apiKey: string): Promise<{ text: string; providerMs: number; sttMs: number; bytes: number }> {
  const wavBytes = await encodeWavForProof([wav.pcm], wav.sampleRate, 16000);
  const result = await transcribeAudio({
    audio: wavBytes,
    mimetype: 'audio/wav',
    language: 'auto',
    apiKey,
  });
  return { text: result.text, providerMs: result.providerMs, sttMs: result.sttMs, bytes: wavBytes.length };
}

async function main() {
  const apiKey = readEnvKey();
  if (!apiKey) {
    console.error('no DEEPGRAM_API_KEY in env or .env — nothing to measure');
    process.exit(1);
  }
  const question = arg('text') ?? 'Quais são as tarefas abertas da casa hoje?';
  const endpointing = Number(arg('endpointing') ?? 500);
  const utteranceEndMs = Number(arg('utterance-end') ?? 1000);
  const houseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-proof-house-'));

  console.log('=== door streaming STT proof ===');
  console.log(`question      : ${question}`);
  console.log(`provider      : deepgram nova-3 · linear16 16 kHz · endpointing=${endpointing} utterance_end=${utteranceEndMs}`);
  console.log(`batch baseline: local VAD silence wait = ${VAD_DEFAULTS.endSilenceMs} ms\n`);

  const wav = await synthesise(question, apiKey);
  const speechMs = Math.round((wav.pcm.length / wav.sampleRate) * 1000);
  console.log(`tts           : ${speechMs} ms of speech @ ${wav.sampleRate} Hz (${wav.channels} ch)\n`);

  // --- A) the streaming path, through OUR relay ---------------------------
  const server = http.createServer();
  const { relay, detach } = attachCoexistirSttStream(server, {
    apiKey,
    config: { endpointing, utteranceEndMs },
    store: { dir: houseDir, turnsFile: path.join(houseDir, 'turns.jsonl'), consultFile: path.join(houseDir, 'q.jsonl'), answersFile: path.join(houseDir, 'a.jsonl'), audioDir: houseDir, voiceIdFile: path.join(houseDir, 'voice-id.jsonl') },
    logger: (line) => console.log(`  ${line}`),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  console.log(`relay         : 127.0.0.1:${port}${STT_STREAM_PATH} (ephemeral, not :4030)\n`);

  let stream: StreamResult | null = null;
  try {
    stream = await runStream(wav, apiKey, port);
  } finally {
    detach();
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('--- provider frames (page clock) ---');
  const t0 = stream.epoch;
  for (const frame of stream.frames) {
    console.log(`  +${String(Math.round(frame.at - t0)).padStart(5)} ms  ${frame.kind.padEnd(9)} ${frame.detail}`);
  }

  console.log('\n--- A) STREAM (provider endpointing) ---');
  console.log(`  transcript        : "${stream.text}"`);
  console.log(`  closed by         : ${stream.by}`);
  console.log(`  last word (page)  : ${stream.lastWordEndPerf === null ? '—' : `+${Math.round(stream.lastWordEndPerf - t0)} ms`}   (provider word clock, mapped)`);
  console.log(`  turn arrived      : +${Math.round(stream.turnAt - t0)} ms`);
  console.log(`  STT from last word: ${stream.fromLastWord} ms   <-- endpointing + relay, as the door measures it`);
  console.log(`  STT from clip end : ${stream.fromClipEnd} ms   <-- physically grounded: last sample of speech -> words`);
  console.log(`  server-reported   : ${stream.sttMsServer} ms`);
  console.log(
    '  note              : the provider\'s word timestamps run ~300 ms AHEAD of the audio clock\n' +
      '                      (its final result is computed on a delayed window), so "from last word"\n' +
      '                      reads lower than the wall-clock wait. Both are printed, neither is adjusted.',
  );

  // --- B) the batch path it replaces --------------------------------------
  const batch = await runBatch(wav, apiKey);
  const batchDoor = VAD_DEFAULTS.endSilenceMs + batch.sttMs;
  console.log('\n--- B) BATCH (clip after a local silence timer) ---');
  console.log(`  transcript        : "${batch.text}"`);
  console.log(`  provider + parse  : ${batch.sttMs} ms (net ${batch.providerMs} ms, ${batch.bytes} B WAV)`);
  console.log(`  + VAD silence wait: ${VAD_DEFAULTS.endSilenceMs} ms`);
  console.log(`  = words available : ~${batchDoor} ms after the last word`);

  console.log('\n--- verdict ---');
  const sameWords = normalize(stream.text) === normalize(batch.text);
  console.log(`  same transcript on both paths  : ${sameWords ? 'yes' : `NO ("${stream.text}" vs "${batch.text}")`}`);
  console.log(`  end of turn from endpointing   : ${stream.by === 'speech_final' ? 'yes (speech_final)' : 'utterance_end (fallback)'}`);
  console.log(`  saved, door's own metric       : ${batchDoor - stream.fromLastWord} ms (provider word clock)`);
  console.log(`  saved, wall clock from speech  : ${batchDoor - stream.fromClipEnd} ms (audio clock)`);

  const ok =
    sameWords &&
    Number.isFinite(stream.fromLastWord) &&
    stream.fromClipEnd < batchDoor &&
    stream.text.trim().length > 0;
  console.log(
    `\nPROOF ${ok ? 'OK' : 'FAILED'}: stream ${stream.fromClipEnd} ms (wall) / ${stream.fromLastWord} ms (door) vs batch ~${batchDoor} ms`,
  );
  process.exit(ok ? 0 : 2);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

void main().catch((err) => {
  console.error('proof failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
