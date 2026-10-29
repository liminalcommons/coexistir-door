/**
 * coexistirVoiceRoutes.test.ts — the bridge contract over real HTTP.
 *
 * Proven here without network, Mongo or Groq:
 * - a smalltalk turn is ONE answer step (talker first, no filler);
 * - a hard turn emits filler BEFORE answer, and the answer names real tasks;
 * - a hard question with no data path is queued for Hermes (the honest seam),
 *   and a Hermes answer clears the queue;
 * - /stream flushes headers, writes the first chunk while the provider is still
 *   "generating", tags the turn, and appends audio timing to the house log;
 * - an unsupported language is a 422, not broken audio.
 */

import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCoexistirVoiceRouter } from '../coexistirVoiceRoutes';
import type { CoexistirTaskView, TaskRepositoryLike } from '../../modules/coexistir/CoexistirTaskRepository';
import { CONSULT_ACK } from '../../modules/coexistir/reflexTalker';
import type { TtsStreamEvent } from '../../modules/voice/ttsStream';
import { UnsupportedLanguageError } from '../../modules/voice/ttsStream';

const tasks: CoexistirTaskView[] = [
  { id: '1', title: 'Buy coffee', status: 'open', createdAt: '2026-10-26T07:00:00.000Z' },
  { id: '2', title: 'Water plants', status: 'open', createdAt: '2026-10-26T07:05:00.000Z' },
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

/** Emits two chunks 70ms apart so "progressive" is measurable, not asserted. */
function fakeStreamer(options: { failWith?: Error } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const impl = (async (request: {
    text: string;
    language?: string;
    res: express.Response;
    extraHeaders?: Record<string, string>;
    teePath?: string | null;
  }): Promise<TtsStreamEvent> => {
    calls.push({ text: request.text, language: request.language, teePath: request.teePath });
    if (options.failWith) throw options.failWith;
    const started = Date.now();
    request.res.status(200);
    request.res.setHeader('Content-Type', 'audio/mpeg');
    request.res.setHeader('X-TTS-Model-Id', 'flux-mariana-pt');
    request.res.setHeader('X-TTS-Language', request.language || 'pt-BR');
    for (const [k, v] of Object.entries(request.extraHeaders ?? {})) request.res.setHeader(k, v);
    request.res.flushHeaders?.();
    request.res.write(Buffer.alloc(1024, 1));
    await new Promise((r) => setTimeout(r, 70));
    request.res.write(Buffer.alloc(1024, 2));
    request.res.end();
    return {
      provider: 'deepgram',
      modelId: 'flux-mariana-pt',
      voiceId: 'mariana',
      language: request.language || 'pt-BR',
      upstreamMs: 12,
      firstChunkMs: 30,
      headersFlushedMs: 20,
      totalMs: Date.now() - started,
      bytes: 2048,
      chunks: 2,
      aborted: false,
    };
  }) as never;
  return { impl, calls };
}

let server: ReturnType<express.application.listen>;
let baseUrl = '';
let dir: string;

async function boot(overrides: Parameters<typeof createCoexistirVoiceRouter>[0] = {}) {
  const streamer = fakeStreamer();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/coexistir/voice',
    createCoexistirVoiceRouter({
      taskRepo: fakeRepo(tasks),
      resolveMemberName: async () => ({ name: 'Ana' }),
      houseDir: dir,
      now: () => new Date('2026-10-27T09:30:00'),
      askTalkerImpl: async ({ language }) => ({
        text: language === 'en' ? "I'm here." : 'Oi! Tudo bem?',
        model: 'qwen/qwen3.8-27b',
        talkerMs: 8,
        fallback: false,
      }),
      streamTtsImpl: streamer.impl,
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/coexistir/voice`;
  return streamer;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'voice-routes-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /turn', () => {
  it('answers smalltalk in one step, with no filler and no consult', async () => {
    await boot();
    const res = await post('/turn', { text: 'oi, tudo bem?', language: 'pt', room: 'coexistir' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.kind).toBe('smalltalk');
    expect(body.sequence).toHaveLength(1);
    expect(body.sequence[0].role).toBe('answer');
    expect(body.filler).toBeNull();
    expect(body.needsConsult).toBe(false);
    expect(body.timings.talkerMs).toBe(8);

    const log = readFileSync(join(dir, 'turns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({
      event: 'turn',
      turnId: body.turnId,
      kind: 'smalltalk',
      input: 'oi, tudo bem?',
      reply: body.answer,
      needsConsult: false,
    });
    expect(log[0].audio.ref).toBe(`audio/${body.turnId}.answer.mp3`);
  });

  it('defaults to Portuguese for a turn that names no language', async () => {
    // The door's pin, at the text route: an absent language must not fall
    // through to the English filler/ack (which is what `normalizeLanguage`
    // did with `undefined`).
    await boot();
    const hard = await (await post('/turn', { text: 'a porta da frente está trancada?' })).json();
    expect(hard.language).toBe('pt');
    expect(hard.answer).toBe(CONSULT_ACK.pt);
    expect(hard.sequence[0].text).toMatch(/conferir|olhar|ver/i);

    const small = await (await post('/turn', { text: 'oi, tudo bem?' })).json();
    expect(small.answer).toBe('Oi! Tudo bem?');
  });

  it('speaks a filler first, then the data answer, for a hard turn', async () => {
    await boot();
    const res = await post('/turn', {
      text: 'o que tem na lista hoje?',
      language: 'pt',
      intent: 'todos',
      voiceKey: 'livekit:u123',
    });
    const body = await res.json();

    expect(body.kind).toBe('hard');
    expect(body.sequence.map((s: { role: string }) => s.role)).toEqual(['filler', 'answer']);
    expect(body.sequence[0].text).toMatch(/conferir|olhar|ver/i);
    expect(body.sequence[1].text).toContain('Buy coffee');
    expect(body.sequence[1].text).toContain('Ana');
    expect(body.needsConsult).toBe(false);
    expect(body.resolvedFrom).toBe('tasks');
    // Both steps stream the same turn id, so the log joins them.
    expect(body.sequence[0].stream.body.turnId).toBe(body.turnId);
    expect(body.sequence[1].stream.body.turnId).toBe(body.turnId);
  });

  it('queues a hard question for Hermes when there is no data path', async () => {
    await boot();
    const res = await post('/turn', { text: 'a porta da frente está trancada?', language: 'pt' });
    const body = await res.json();

    expect(body.kind).toBe('hard');
    expect(body.needsConsult).toBe(true);
    expect(body.consultQueued).toBe(true);
    expect(body.answer).toBe(CONSULT_ACK.pt);

    const pendingRes = await fetch(`${baseUrl}/consult/pending`);
    const pending = await pendingRes.json();
    expect(pending.count).toBe(1);
    expect(pending.pending[0]).toMatchObject({
      turnId: body.turnId,
      question: 'a porta da frente está trancada?',
      status: 'pending',
    });

    // Hermes writes back; the queue drains.
    const answered = await post('/consult/answer', {
      turnId: body.turnId,
      answer: 'Está trancada; fechei às 22h.',
      answeredBy: 'hermes-cron',
    });
    const answerBody = await answered.json();
    expect(answerBody.pending).toBe(0);
    const after = await (await fetch(`${baseUrl}/consult/pending`)).json();
    expect(after.count).toBe(0);
  });

  it('rejects an empty turn', async () => {
    await boot();
    const res = await post('/turn', { text: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /stream', () => {
  it('flushes headers, streams chunks progressively and logs audio timing', async () => {
    const streamer = await boot();
    const started = Date.now();
    const res = await post('/stream', {
      text: 'Bom dia, Ana. Uma coisa ainda está aberta para a casa.',
      language: 'pt',
      turnId: 't_stream',
      kind: 'answer',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turn-id')).toBe('t_stream');
    expect(res.headers.get('x-tts-model-id')).toBe('flux-mariana-pt');

    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = Date.now();
    let bytes = first.value?.length ?? 0;
    let chunks = first.value ? 1 : 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      chunks += 1;
    }
    const lastAt = Date.now();

    expect(bytes).toBe(2048);
    expect(chunks).toBe(2);
    // The first chunk arrived before the provider finished the clip.
    expect(firstAt - started).toBeLessThan(lastAt - started);
    expect(lastAt - firstAt).toBeGreaterThanOrEqual(50);
    expect(String((streamer.calls[0] as { language?: string }).language)).toMatch(/^pt/);

    const audio = readFileSync(join(dir, 'turns.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((row) => row.event === 'audio');
    expect(audio).toMatchObject({
      turnId: 't_stream',
      kind: 'answer',
      bytes: 2048,
      chunks: 2,
      modelId: 'flux-mariana-pt',
      aborted: false,
    });
    expect(audio.timings.firstChunkMs).toBe(30);
    expect(audio.ref).toBe('audio/t_stream.answer.mp3');
  });

  it('maps an unsupported language to a clean 422', async () => {
    await boot({
      streamTtsImpl: (async () => {
        throw new UnsupportedLanguageError('fr', ['pt-BR', 'en']);
      }) as never,
    });
    const res = await post('/stream', { text: 'Bonjour', language: 'fr' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'unsupported_language', requestedLanguage: 'fr' });
  });
});

/**
 * Who is speaking — the fix for `speaker: null` on every door turn.
 *
 * The panel used to answer "who is this?" with the kiosk's claim pinned above a
 * turn that recorded nobody. These specs pin the new contract: the row and the
 * response carry the claim name + claim state, a cold cache is recorded as
 * `pending` (not as "no claim"), and the identity record never invents a
 * biometric confidence.
 */
describe('identity on the turn row', () => {
  const verified = (voiceKey: string) => ({
    voiceKey,
    name: 'Ana',
    claim: 'verified' as const,
    claims: 2,
    verified: 1,
    biometric: false as const,
    confidence: null,
    source: 'voiceKey+name-claims' as const,
    state: 'resolved' as const,
    resolvedAt: '2026-10-27T09:00:00.000Z',
  });

  it('records the claim name, the claim state and the honest gaps', async () => {
    const seen: string[] = [];
    await boot({
      identity: {
        peek: verified,
        refresh: async (key: string) => {
          seen.push(key);
          return verified(key);
        },
        ensure: async (key: string) => verified(key),
      },
    });
    const body = await (
      await post('/turn', {
        text: 'oi, tudo bem?',
        language: 'pt',
        room: 'coexistir',
        voiceKey: 'owl:front-door',
      })
    ).json();

    expect(seen).toEqual(['owl:front-door']);
    expect(body.identity).toMatchObject({
      name: 'Ana',
      claim: 'verified',
      biometric: false,
      confidence: null,
    });
    expect(body.speaker).toBe('Ana');

    const row = readFileSync(join(dir, 'turns.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((r) => r.event === 'turn');
    expect(row.speaker).toBe('Ana');
    expect(row.identity).toMatchObject({
      claim: 'verified',
      claims: 2,
      verified: 1,
      confidence: null,
      source: 'voiceKey+name-claims',
    });
  });

  it('records a cold cache as pending, never as "no claim"', async () => {
    await boot({
      identity: {
        peek: (key: string) => ({
          voiceKey: key,
          name: null,
          claim: 'none',
          claims: 0,
          verified: 0,
          biometric: false,
          confidence: null,
          source: 'voiceKey+name-claims',
          state: 'pending',
          resolvedAt: null,
        }),
        refresh: async () => null,
        ensure: async (key: string) => ({
          voiceKey: key,
          name: null,
          claim: 'none',
          claims: 0,
          verified: 0,
          biometric: false,
          confidence: null,
          source: 'voiceKey+name-claims',
          state: 'pending',
          resolvedAt: null,
        }),
      },
    });
    const body = await (
      await post('/turn', { text: 'oi, tudo bem?', voiceKey: 'owl:front-door' })
    ).json();
    expect(body.identity.state).toBe('pending');
    // No name was invented, and `speaker` stays null because nobody claimed one.
    expect(body.identity.name).toBeNull();
    expect(body.speaker).toBeNull();
  });

  it('serves the live identity over GET /identity', async () => {
    await boot({
      identity: {
        peek: verified,
        refresh: async (key: string) => verified(key),
        ensure: async (key: string) => verified(key),
      },
    });
    const res = await fetch(`${baseUrl}/identity?voiceKey=owl:front-door`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toMatchObject({ name: 'Ana', claim: 'verified', confidence: null });
  });

  it('rejects an identity read with no voiceKey instead of guessing one', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/identity`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/voiceKey/);
    expect(body.identity).toBeNull();
  });
});
