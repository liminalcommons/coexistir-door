/**
 * coexistirVoiceVoiceId.test.ts — voice identity over real HTTP.
 *
 * The door's actual sequence is reproduced: `POST /stt` with a 16 kHz WAV, then
 * `POST /turn` with the transcript and NO id linking them (that is what the
 * client sends today). What must be true afterwards:
 *
 * - the turn row carries `speaker` + `claim` + `voice` (printId, similarity,
 *   matched, traceId), so a turn is no longer `speaker: null` for a known voice;
 * - a stranger's turn carries `speaker: null` and a printId with no claim — the
 *   door groups the voice without naming it;
 * - the claim events reach a real SSE client (`GET /voice/id/stream?debug=1`),
 *   and the same endpoints are closed without the debug gate;
 * - STT latency does not regress: the fingerprint runs during the provider
 *   wait (`readyBeforeStt`), the handler never awaits it (`waitedMs` does not
 *   exist because there is no wait), and an A/B run with identity disabled is
 *   within noise of the enabled one.
 */

import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCoexistirVoiceRouter } from '../coexistirVoiceRoutes';
import type { TranscribeRequest, TranscribeResult } from '../../modules/voice/deepgramStt';
import type { TaskRepositoryLike } from '../../modules/coexistir/CoexistirTaskRepository';
import {
  VOICEPRINT_DIMS,
  VoiceprintRegistry,
  computeFingerprint,
  decodeWav,
} from '../../modules/voice/voiceIdentity';
import { VoiceIdBus } from '../../modules/voice/voiceIdBus';
import { VOICE_A, VOICE_A_AGAIN, VOICE_B, voiceWav } from '../../modules/voice/__tests__/wavFixture';

const FILLER = 'Deixa eu ver.';
const ANSWER = 'A casa está em ordem.';

function fakeRepo(): TaskRepositoryLike {
  return {
    list: async () => [],
    create: async (data) => ({
      id: 'x',
      title: data.title,
      status: 'open',
      createdBy: data.createdBy,
      createdAt: new Date().toISOString(),
    }),
    setStatus: async () => null,
    clear: async () => 0,
  };
}

/** A transcriber that really spends `delayMs` on the wire (no network). */
function slowTranscriber(delayMs: number, fail = false) {
  const calls: TranscribeRequest[] = [];
  const impl = (async (request: TranscribeRequest): Promise<TranscribeResult> => {
    calls.push(request);
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ok: !fail,
      provider: 'deepgram',
      model: 'nova-3',
      text: fail ? '' : 'me dá o briefing da casa',
      ...(fail ? { reason: 'http' as const, status: 401, detail: 'Invalid credentials' } : {}),
      language: 'pt',
      detectedLanguage: 'pt',
      languageConfidence: 0.999,
      confidence: 0.97,
      durationSec: 2.4,
      bytes: request.audio.byteLength,
      mimetype: request.mimetype || 'audio/wav',
      sttMs: Date.now() - started,
      providerMs: Date.now() - started,
      status: 200,
    };
  }) as never;
  return { impl, calls };
}

interface BootOptions {
  voiceId?: boolean;
  delayMs?: number;
  /** Force a provider failure (the ear still fingerprints the bytes). */
  failStt?: boolean;
  onClaim?: (voiceKey: string) => void;
}

let dir: string;
let server: ReturnType<express.application.listen> | null = null;
let baseUrl = '';

/**
 * Opt-in evidence artifact: with `VOICE_ID_EVIDENCE=<path>` the suite writes the
 * exact shapes it produced (turn row, voice row, SSE events, latency numbers),
 * so a reviewer reads real output instead of a test name.
 */
const evidence: Record<string, unknown> = {};

afterAll(() => {
  const target = process.env.VOICE_ID_EVIDENCE;
  if (!target) return;
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
});

async function boot(options: BootOptions = {}): Promise<void> {
  const transcriber = slowTranscriber(options.delayMs ?? 120, options.failStt === true);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/coexistir/voice',
    createCoexistirVoiceRouter({
      taskRepo: fakeRepo(),
      resolveMemberName: async () => ({}),
      houseDir: dir,
      voiceId: options.voiceId ?? true,
      // Fresh bus per boot: a test must not inherit another test's observations
      // (the production default is the process-wide singleton).
      voiceBus: new VoiceIdBus(),
      transcribeImpl: transcriber.impl,
      // A claim, not an identity: the exact shape `voice_name_claims` returns.
      resolveClaimImpl: async (voiceKey: string) => {
        options.onClaim?.(voiceKey);
        return voiceKey === 'owl:spk_07' ? { name: 'Ana', status: 'verified' } : null;
      },
      sttWarmup: false,
      askTalkerImpl: async () => ({
        text: ANSWER,
        model: 'test',
        talkerMs: 1,
        fallback: false,
      }),
      streamTtsImpl: (async () => ({
        language: 'pt',
        modelId: 'test',
        voiceId: 'test',
        bytes: 0,
        chunks: 0,
        aborted: false,
        upstreamMs: 0,
        firstChunkMs: 0,
        headersFlushedMs: 0,
        totalMs: 0,
        abortMs: 0,
      })) as never,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/coexistir/voice`;
}

/** The steward's voice is the only enrolled print. */
function enrollSteward(): string {
  const decoded = decodeWav(voiceWav(VOICE_A));
  const fingerprint = computeFingerprint(decoded);
  expect(fingerprint.ok).toBe(true);
  const registry = new VoiceprintRegistry({ dir, log: () => undefined });
  const print = registry.enroll({
    voiceKey: 'owl:spk_07',
    vector: fingerprint.fingerprint!.vector,
    source: 'test-enrollment',
  });
  return print.printId;
}

async function stt(wav: Buffer): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/stt?language=auto&room=coexistir`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function turn(text: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: 'pt', room: 'coexistir', ...extra }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function turnRows(): Array<Record<string, unknown>> {
  return readFileSync(join(dir, 'turns.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.event === 'turn');
}

function voiceRows(): Array<Record<string, unknown>> {
  return readFileSync(join(dir, 'voice-id.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Collect SSE `voice-id` events from a real stream, with a wait-for helper. */
async function sseClient(timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(`${baseUrl}/id/stream?debug=1&room=coexistir`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = '';

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted by the timeout: the collected events are still evidence */
    }
  })();

  return {
    events,
    /** Resolve as soon as one matching event arrived (or the deadline hits). */
    async waitFor(predicate: (event: Record<string, unknown>) => boolean, ms = 3000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = events.find(predicate);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return null;
    },
    async close() {
      clearTimeout(timer);
      controller.abort();
      await pump.catch(() => undefined);
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-id-route-'));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('the ear identifies the steward and the turn carries it', () => {
  it('puts speaker, claim and the voice print on the turn record', async () => {
    const printId = enrollSteward();
    await boot();

    const heard = await stt(voiceWav(VOICE_A_AGAIN));
    const voice = heard.voice as Record<string, unknown>;
    expect(voice.status).toBe('identified');
    expect(voice.voiceKey).toBe('owl:spk_07');
    expect(voice.printId).toBe(printId);
    expect(voice.dims).toBe(VOICEPRINT_DIMS);
    expect(Number(voice.similarity)).toBeGreaterThan(0.82);
    expect(voice.traceId).toEqual(expect.any(String));

    const plan = await turn(String(heard.text));
    expect(plan.speaker).toBe('Ana');
    expect(plan.speakerSource).toBe('claim');
    expect(plan.claim).toMatchObject({ name: 'Ana', status: 'verified', voiceKey: 'owl:spk_07' });
    expect(plan.voice).toMatchObject({
      status: 'identified',
      printId,
      voiceKey: 'owl:spk_07',
      matched: true,
      claimStatus: 'resolved',
    });

    const row = turnRows()[0];
    expect(row.speaker).toBe('Ana');
    expect(row.speakerSource).toBe('claim');
    expect(row.voiceKey).toBe('owl:spk_07');
    expect((row.voice as Record<string, unknown>).printId).toBe(printId);
    expect((row.claim as Record<string, unknown>).status).toBe('verified');
    // The default `houseTranscript` fields are untouched.
    expect(row.kind).toBe('hard');
    expect(row.input).toBe('me dá o briefing da casa');

    // The append-only mirror: one observed row, then one attached row with the
    // turnId — a panel that only polls files still sees the join.
    const traceId = (heard.voice as Record<string, unknown>).traceId as string;
    let rows: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      rows = voiceRows().filter((r) => r.traceId === traceId);
      if (rows.some((r) => r.phase === 'attached')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(rows.map((r) => r.phase)).toEqual(['observed', 'attached']);
    expect(rows[1].turnId).toBe(row.turnId);
    expect(rows[1].claim).toMatchObject({ name: 'Ana', status: 'verified' });
  });

  it('leaves a stranger nameless but still prints the voice', async () => {
    enrollSteward();
    await boot();

    const heard = await stt(voiceWav(VOICE_B));
    const voice = heard.voice as Record<string, unknown>;
    expect(voice.status).toBe('unenrolled');
    expect(voice.matched).toBe(false);
    expect(voice.voiceKey).toBeNull();
    expect(String(voice.printId)).toMatch(/^vp_/);

    const plan = await turn(String(heard.text));
    expect(plan.speaker).toBeNull();
    expect(plan.speakerSource).toBeNull();
    expect(plan.claim).toBeNull();
    expect(plan.voice).toMatchObject({
      status: 'unenrolled',
      voiceKey: null,
      matched: false,
      claimStatus: 'none',
    });

    const row = turnRows()[0];
    expect(row.speaker).toBeNull();
    expect(row.claim).toBeNull();
    expect((row.voice as Record<string, unknown>).printId).toBe(voice.printId);
  });

  it('gives a voice-less turn `voice.status: no_audio`, never a stale name', async () => {
    enrollSteward();
    await boot();
    await stt(voiceWav(VOICE_A));

    // First turn consumes the observation…
    const first = await turn('bom dia');
    expect(first.speaker).toBe('Ana');
    // …so the greeting that follows cannot inherit it.
    const second = await turn('e agora?');
    expect(second.speaker).toBeNull();
    expect((second.voice as Record<string, unknown>).status).toBe('no_audio');
  });

  it('fingerprints a clip the provider failed to transcribe, but lends it to nobody', async () => {
    enrollSteward();
    await boot({ failStt: true });

    const res = await fetch(`${baseUrl}/stt?language=auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: voiceWav(VOICE_A),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    // The bytes were still identified: the panel can show "this voice, unheard".
    expect((body.voice as Record<string, unknown>).status).toBe('identified');
    expect((body.voice as Record<string, unknown>).voiceKey).toBe('owl:spk_07');

    // …but the following turn gets no voice: no transcript, no link.
    const plan = await turn('alguém me ouve?');
    expect(plan.speaker).toBeNull();
    expect(plan.claim).toBeNull();
    expect((plan.voice as Record<string, unknown>).status).toBe('no_audio');

    // The identity row is still on disk for the debug panel.
    const traceId = (body.voice as Record<string, unknown>).traceId as string;
    expect(voiceRows().some((row) => row.traceId === traceId)).toBe(true);
  });
});

describe('claim events reach a test client', () => {
  it('streams observed + claim + attached over SSE, behind the debug gate', async () => {
    const printId = enrollSteward();
    await boot();
    const client = await sseClient();

    const heard = await stt(voiceWav(VOICE_A));
    const plan = await turn(String(heard.text));
    const traceId = (heard.voice as Record<string, unknown>).traceId as string;

    const observed = await client.waitFor(
      (event) => event.event === 'observed' && event.traceId === traceId,
    );
    const attached = await client.waitFor(
      (event) => event.event === 'attached' && event.turnId === plan.turnId,
    );
    const collected = client.events.slice();
    await client.close();
    console.log(`[voice-id] sse events=${JSON.stringify(collected.map((e) => `${e.event}:${e.traceId}`))}`);

    expect(observed).toBeTruthy();
    expect(observed).toMatchObject({ type: 'voice-id', printId, voiceKey: 'owl:spk_07', matched: true });

    expect(attached).toBeTruthy();
    expect(attached).toMatchObject({
      speaker: 'Ana',
      claimStatus: 'resolved',
      claim: { name: 'Ana', status: 'verified' },
      printId,
    });

    // And the same data is readable without a stream, by polling.
    const latest = await fetch(`${baseUrl}/id/latest?debug=1&room=coexistir`).then((res) => res.json());
    expect(latest.latest).toMatchObject({ traceId, printId, voiceKey: 'owl:spk_07' });
    expect(latest.threshold).toBeGreaterThan(0.5);

    const rows = await fetch(`${baseUrl}/id/events?debug=1`).then((res) => res.json());
    expect(rows.rows.some((row: Record<string, unknown>) => row.traceId === traceId)).toBe(true);

    evidence.turnRequest = { text: String(heard.text), room: 'coexistir', voiceTraceIdSent: false };
    evidence.turnRow = turnRows()[0];
    evidence.voiceRow = rows.rows.find((row: Record<string, unknown>) => row.traceId === traceId);
    evidence.sseEvents = collected.map((event) => ({
      event: event.event,
      traceId: event.traceId,
      turnId: event.turnId,
      status: event.status,
      printId: event.printId,
      voiceKey: event.voiceKey,
      matched: event.matched,
      similarity: event.similarity,
      claimStatus: event.claimStatus,
      claim: event.claim,
      speaker: event.speaker,
      ms: event.ms,
    }));
  });

  it('refuses the id endpoints without the debug gate', async () => {
    await boot();
    for (const path of ['/id/latest', '/id/events', '/id/stream']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('debug_only');
    }
  });
});

describe('latency', () => {
  /**
   * The proof is structural + measured: the fingerprint is queued AFTER the
   * provider call is issued, the handler never awaits it, and the fingerprint
   * CPU time (a few ms) is absorbed by the provider wait (120 ms here).
   */
  it('adds no measurable time to the STT response', async () => {
    enrollSteward();
    await boot({ delayMs: 120 });

    const samples: Array<{
      sttMs: number;
      providerMs: number;
      overheadMs: number;
      wallMs: number;
      voiceMs: number;
      cpuMs: number;
      ready: boolean;
    }> = [];
    for (const wav of [voiceWav(VOICE_A), voiceWav(VOICE_A_AGAIN), voiceWav(VOICE_A)]) {
      const started = performance.now();
      const heard = await stt(wav);
      const wallMs = performance.now() - started;
      const voice = heard.voice as Record<string, unknown>;
      const sttMs = Number(heard.sttMs);
      const providerMs = Number(heard.providerMs);
      samples.push({
        sttMs,
        providerMs,
        overheadMs: sttMs - providerMs,
        wallMs: Math.round(wallMs),
        voiceMs: Number(voice.ms),
        cpuMs: Number(voice.cpuMs),
        ready: voice.readyBeforeStt === true,
      });
    }

    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const sttMean = mean(samples.map((s) => s.sttMs));
    const providerMean = mean(samples.map((s) => s.providerMs));
    const overheadMean = mean(samples.map((s) => s.overheadMs));
    const voiceMean = mean(samples.map((s) => s.voiceMs));
    const cpuMean = mean(samples.map((s) => s.cpuMs));
    console.log(
      `[voice-id] latency ${JSON.stringify({
        sttMeanMs: Math.round(sttMean),
        providerMeanMs: Math.round(providerMean),
        routeOverheadMeanMs: Math.round(overheadMean * 10) / 10,
        wallMeanMs: Math.round(mean(samples.map((s) => s.wallMs))),
        fingerprintMeanMs: Math.round(voiceMean * 100) / 100,
        fingerprintCpuMeanMs: Math.round(cpuMean * 100) / 100,
        readyBeforeStt: samples.every((s) => s.ready),
      })}`,
    );

    // The handler waited for the provider (120 ms) and nothing else: the
    // difference between the response time and the provider time is body
    // parse + log append, and it must not carry the fingerprint.
    expect(sttMean).toBeGreaterThanOrEqual(115);
    expect(overheadMean).toBeLessThan(25);
    expect(samples.every((s) => s.ready)).toBe(true);
    // `readyBeforeStt` is the structural proof: the fingerprint had ALREADY
    // finished when the transcript arrived, i.e. it fit inside the provider
    // wait. `overheadMean` (sttMs - providerMs) is the measured proof that the
    // response did not wait for it. The ms/cpuMs numbers are reported for the
    // record — on a loaded Windows host process.cpuUsage() is coarse (±15 ms
    // ticks, GC included), so they are a ceiling, not a hard floor.
    expect(samples.filter((s) => s.ready).length).toBe(samples.length);
    expect(samples.every((s) => s.cpuMs >= 0)).toBe(true);
    expect(cpuMean).toBeLessThan(120);
    expect(voiceMean).toBeLessThan(120);

    evidence.latency = {
      providerDelayMs: 120,
      sttMeanMs: Math.round(sttMean),
      providerMeanMs: Math.round(providerMean),
      routeOverheadMeanMs: Math.round(overheadMean * 10) / 10,
      wallMeanMs: Math.round(mean(samples.map((s) => s.wallMs))),
      fingerprintMeanMs: Math.round(voiceMean * 100) / 100,
      fingerprintCpuMeanMs: Math.round(cpuMean * 100) / 100,
      readyBeforeStt: samples.every((s) => s.ready),
      samples,
    };
  }, 30_000);

  it('is within noise of the identity-off path (A/B)', async () => {
    enrollSteward();
    const RUNS = 3;
    const collect = async (runs: number) => {
      const rows: Array<{ sttMs: number; providerMs: number; overheadMs: number }> = [];
      for (let i = 0; i < runs; i += 1) {
        const heard = await stt(voiceWav(VOICE_A));
        const sttMs = Number(heard.sttMs);
        const providerMs = Number(heard.providerMs);
        rows.push({ sttMs, providerMs, overheadMs: sttMs - providerMs });
      }
      return rows;
    };

    await boot({ delayMs: 60, voiceId: false });
    const off = await collect(RUNS);
    for (const row of off) expect(row.sttMs).toBeGreaterThanOrEqual(55);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    await boot({ delayMs: 60, voiceId: true });
    const on = await collect(RUNS);
    for (const row of on) expect(row.sttMs).toBeGreaterThanOrEqual(55);

    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const medianOff = median(off.map((row) => row.sttMs));
    const medianOn = median(on.map((row) => row.sttMs));
    // The honest metric: everything the route did BESIDES waiting for the
    // provider (body parse + log append). Identity must not show up here.
    const overheadOff = median(off.map((row) => row.overheadMs));
    const overheadOn = median(on.map((row) => row.overheadMs));
    console.log(
      `[voice-id] A/B { sttOff: ${medianOff}, sttOn: ${medianOn}, ` +
        `overheadOff: ${overheadOff}, overheadOn: ${overheadOn} }`,
    );

    // Wall clock on a shared host varies with the jest workers; the overhead
    // delta is the part the code controls, and it must be ~0.
    expect(overheadOn - overheadOff).toBeLessThanOrEqual(8);
    expect(medianOn - medianOff).toBeLessThan(45);

    evidence.abLatency = {
      providerDelayMs: 60,
      runs: RUNS,
      sttMsOff: off.map((row) => row.sttMs),
      sttMsOn: on.map((row) => row.sttMs),
      overheadOff,
      overheadOn,
      medianOffMs: medianOff,
      medianOnMs: medianOn,
      deltaMs: medianOn - medianOff,
      overheadDeltaMs: overheadOn - overheadOff,
    };
  }, 30_000);
});
