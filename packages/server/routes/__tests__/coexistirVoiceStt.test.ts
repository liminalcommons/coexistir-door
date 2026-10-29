/**
 * coexistirVoiceStt.test.ts — the ear, over real HTTP.
 *
 * Proven without Deepgram or network:
 * - a recorded clip is accepted as a RAW `audio/*` body and handed to the
 *   transcriber with the codec stripped from the MIME type (what the provider
 *   wants) and the bytes intact;
 * - the transcript, detected language and `sttMs` come back to the portal, and
 *   the same numbers land in the house log as an `stt` row (one timeline with
 *   the turn and audio rows);
 * - `language=auto` asks for detection, an explicit tag pins the language;
 * - a missing upload is a 400, a provider failure is a typed 502/503 body —
 *   never a fabricated transcript.
 */

import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCoexistirVoiceRouter } from '../coexistirVoiceRoutes';
import type { CoexistirTaskView, TaskRepositoryLike } from '../../modules/coexistir/CoexistirTaskRepository';
import type { TranscribeRequest, TranscribeResult } from '../../modules/voice/deepgramStt';

const tasks: CoexistirTaskView[] = [
  { id: '1', title: 'Buy coffee', status: 'open', createdAt: '2026-10-26T07:00:00.000Z' },
];

function fakeRepo(rows: CoexistirTaskView[]): TaskRepositoryLike {
  return {
    list: async () => rows.map((r) => ({ ...r })),
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

/** Deterministic result for one transcribed clip. */
function okResult(overrides: Partial<TranscribeResult> = {}): TranscribeResult {
  return {
    ok: true,
    provider: 'deepgram',
    model: 'nova-3',
    text: 'me dá o briefing da casa hoje',
    language: 'pt',
    detectedLanguage: 'pt',
    languageConfidence: 0.999,
    confidence: 0.98,
    durationSec: 3.26,
    bytes: 4096,
    mimetype: 'audio/webm',
    sttMs: 180,
    providerMs: 160,
    status: 200,
    ...overrides,
  };
}

function fakeTranscriber(result: TranscribeResult | ((request: TranscribeRequest) => TranscribeResult) = okResult()) {
  const calls: TranscribeRequest[] = [];
  const impl = (async (request: TranscribeRequest): Promise<TranscribeResult> => {
    calls.push(request);
    return typeof result === 'function' ? result(request) : result;
  }) as never;
  return { impl, calls };
}

let server: ReturnType<express.application.listen>;
let baseUrl = '';
let dir: string;

/** Clock that advances 250 ms per reading, so `sttMs` is predictable. */
function steppingClock(start = 1000, step = 250) {
  let value = start;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

async function boot(
  overrides: Parameters<typeof createCoexistirVoiceRouter>[0] & {
    /** Convenience: build a fake transcriber that always answers this. */
    transcribeResult?: TranscribeResult;
  } = {},
): Promise<{ calls: TranscribeRequest[] }> {
  const { transcribeResult, ...deps } = overrides;
  const transcriber = fakeTranscriber(
    transcribeResult ??
      ((request: TranscribeRequest) =>
        okResult({ bytes: request.audio.byteLength, mimetype: request.mimetype || 'audio/webm' })),
  );
  const app = express();
  app.use(express.json());
  app.use(
    '/api/coexistir/voice',
    createCoexistirVoiceRouter({
      taskRepo: fakeRepo(tasks),
      resolveMemberName: async () => ({ name: 'Ana' }),
      houseDir: dir,
      now: () => new Date('2026-10-27T09:30:00'),
      clock: steppingClock(),
      askTalkerImpl: async () => ({
        text: 'Oi!',
        model: 'qwen/qwen3.8-27b',
        talkerMs: 5,
        fallback: false,
      }),
      ...deps,
      transcribeImpl: deps.transcribeImpl ?? transcriber.impl,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/coexistir/voice`;
  return { calls: transcriber.calls };
}

function audioRow(file = 'turns.jsonl') {
  const rows = readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return rows;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-stt-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const CLIP = Buffer.alloc(4096, 7);

describe('POST /stt', () => {
  it('transcribes a raw webm clip, returns sttMs and logs the row', async () => {
    const { calls } = await boot();
    const res = await fetch(`${baseUrl}/stt?language=auto&room=coexistir`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm;codecs=opus' },
      body: CLIP,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.text).toBe('me dá o briefing da casa hoje');
    expect(body.language).toBe('pt');
    expect(body.detectedLanguage).toBe('pt');
    expect(typeof body.sttMs).toBe('number');
    expect(res.headers.get('x-stt-language')).toBe('pt');
    expect(Number(res.headers.get('x-stt-ms'))).toBeGreaterThanOrEqual(0);

    // The provider got the exact bytes, a codec-free MIME type and `auto`.
    expect(calls).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(calls[0].audio), CLIP)).toBe(0);
    expect(calls[0].mimetype).toBe('audio/webm');
    expect(calls[0].language).toBe('auto');

    const rows = audioRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'stt',
      room: 'coexistir',
      text: 'me dá o briefing da casa hoje',
      detectedLanguage: 'pt',
      language: 'auto',
      ok: true,
      mimetype: 'audio/webm',
      bytes: 4096,
    });
    expect(typeof rows[0].sttMs).toBe('number');
  });

  it('pins the language when the caller names one', async () => {
    const { calls } = await boot();
    const res = await fetch(`${baseUrl}/stt?language=en-US`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: CLIP,
    });
    expect(res.status).toBe(200);
    expect(calls[0].language).toBe('en-US');
  });

  it('rejects a missing upload without calling the provider', async () => {
    const { calls } = await boot();
    const res = await fetch(`${baseUrl}/stt`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('missing_audio');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a provider failure as a typed 502, never a fake transcript', async () => {
    await boot({
      transcribeImpl: (async () =>
        okResult({
          ok: false,
          text: '',
          language: null,
          detectedLanguage: null,
          reason: 'http',
          status: 401,
          detail: 'Invalid credentials',
        })) as never,
    });
    const res = await fetch(`${baseUrl}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: CLIP,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.text).toBe('');
    expect(body.reason).toBe('http');
    expect(body.detail).toBe('Invalid credentials');

    // The failure is still logged: "the door could not hear" is evidence.
    const rows = audioRow();
    expect(rows[0]).toMatchObject({ event: 'stt', ok: false, reason: 'http', text: '' });
  });

  it('reports a missing API key as 503, not as silence', async () => {
    await boot({
      transcribeImpl: (async () => okResult({ ok: false, text: '', language: null, reason: 'no_key' })) as never,
    });
    const res = await fetch(`${baseUrl}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: CLIP,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe('no_key');
  });

  it('pins Portuguese when the provider mislabels a Portuguese clip as English', async () => {
    // Real misfire from this rig: clear PT heard as EN at 0.941. The door must
    // answer in Portuguese even though the provider said otherwise.
    await boot({
      transcribeImpl: (async () =>
        okResult({
          text: 'Hola Mara, Okay Esta Hoberto para a Casa Hoggi',
          language: 'en',
          detectedLanguage: 'en',
          languageConfidence: 0.9407337,
        })) as never,
    });
    const res = await fetch(`${baseUrl}/stt?language=auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: CLIP,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.language).toBe('pt');
    expect(body.detectedLanguage).toBe('en');
    expect(body.detectedTurnLanguage).toBe('en');
    expect(body.languageDecision).toMatchObject({ language: 'pt', reason: 'pt-evidence', overridden: true });
    expect(res.headers.get('x-door-language')).toBe('pt');
    expect(res.headers.get('x-door-language-override')).toBe('1');

    // The disagreement is on disk, next to the transcript it belongs to.
    const rows = audioRow();
    expect(rows[0]).toMatchObject({
      event: 'stt',
      language: 'auto',
      detectedLanguage: 'en',
      doorLanguage: 'pt',
      detectedTurnLanguage: 'en',
      languageReason: 'pt-evidence',
    });
  });

  it('lets an unmistakable English clip through to the English voice', async () => {
    await boot({
      transcribeImpl: (async () =>
        okResult({
          text: 'Mara, what is on the list today?',
          language: 'en',
          detectedLanguage: 'en',
          languageConfidence: 0.99835205,
        })) as never,
    });
    const res = await fetch(`${baseUrl}/stt?language=auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: CLIP,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.language).toBe('en');
    expect(body.languageDecision).toMatchObject({ language: 'en', reason: 'detected-en', overridden: false });
    expect(res.headers.get('x-door-language')).toBe('en');
    expect(res.headers.get('x-door-language-override')).toBe('0');
    expect(audioRow()[0]).toMatchObject({ doorLanguage: 'en', languageReason: 'detected-en' });
  });

  it('hands the transcript to the existing /turn bridge unchanged', async () => {
    await boot();
    const ear = await fetch(`${baseUrl}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: CLIP,
    });
    const heard = (await ear.json()) as { text: string; language: string };

    // The portal's next call is the pre-existing text route — same body shape.
    const turn = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: heard.text,
        language: heard.language,
        voiceKey: 'owl:front-door',
        room: 'coexistir',
      }),
    });
    expect(turn.status).toBe(200);
    const plan = (await turn.json()) as { sequence: Array<{ role: string }>; language: string };
    expect(plan.language).toBe('pt');
    expect(plan.sequence.map((s) => s.role)).toEqual(['filler', 'answer']);
  });
});
