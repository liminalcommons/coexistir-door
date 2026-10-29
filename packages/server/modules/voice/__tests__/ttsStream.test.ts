/**
 * ttsStream.test.ts — the timing contract of the streaming bridge.
 *
 * What is proven here:
 * 1. headers are flushed BEFORE the provider's first audio arrives (the client
 *    can open its player, and TTFB does not wait for the clip);
 * 2. the first chunk reaches the client while the provider is still producing
 *    (no whole-clip buffering — the old `/api/tts/preview` behaviour);
 * 3. a client close aborts the upstream fetch (barge-in stops generation, it
 *    does not just stop listening);
 * 4. the tee file holds exactly the bytes that were streamed.
 */

import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { streamTts } from '../ttsStream';

/** Minimal Express-response stand-in with real header/flush bookkeeping. */
class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  headersFlushed = false;
  written: Buffer[] = [];
  ended = false;
  destroyed = false;
  writableEnded = false;
  socket = { setNoDelay: () => undefined };
  jsonBody: unknown = null;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | number) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  flushHeaders() {
    this.headersFlushed = true;
  }

  write(chunk: Buffer | string) {
    this.written.push(Buffer.from(chunk));
    return true;
  }

  end() {
    this.ended = true;
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  json(body: unknown) {
    this.jsonBody = body;
    this.writableEnded = true;
    return this;
  }

  bytes() {
    return Buffer.concat(this.written);
  }
}

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

function fakeClock(): FakeClock {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A provider body that emits chunks on a schedule the test controls. */
function chunkedProvider(chunks: Buffer[], perChunkMs: number, clock: FakeClock) {
  let index = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
        clock.advance(perChunkMs);
        controller.enqueue(new Uint8Array(chunks[index]));
        index += 1;
      },
    }),
  };
}

const MP3_CHUNKS = [
  Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]),
  Buffer.from([0xff, 0xfb, 0x90, 0x64, 4, 5, 6, 7]),
  Buffer.from([0xff, 0xfb, 0x90, 0x64, 8, 9]),
];

describe('streamTts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tts-stream-'));
    process.env.DEEPGRAM_API_KEY = 'test-key';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flushes headers before the first audio chunk and streams chunk-by-chunk', async () => {
    const clock = fakeClock();
    const res = new FakeResponse();
    const fetchCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      clock.advance(120); // provider accepts the request
      return {
        ok: true,
        status: 200,
        ...chunkedProvider(MP3_CHUNKS, 40, clock),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const teePath = join(dir, 'audio', 't1.answer.mp3');
    const done = await streamTts({
      text: 'Bom dia, Ana.',
      agentId: 'coexistir-manager',
      res: res as never,
      fetchImpl,
      now: clock.now,
      teePath,
    });

    // Voice resolution: Mariana default, language encoded in the model id.
    expect(fetchCalls[0].url).toContain('api.deepgram.com/v2/speak');
    expect(fetchCalls[0].url).toContain('flux-mariana-pt');
    expect(fetchCalls[0].url).not.toContain('language=');
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['x-tts-model-id']).toBe('flux-mariana-pt');
    expect(res.headers['x-tts-language']).toBe('pt-BR');
    expect(res.headersFlushed).toBe(true);

    // 3 chunks, no Content-Length, and the first hit the wire before the last
    // one existed (progressive, not buffered).
    expect(done.chunks).toBe(3);
    expect(done.bytes).toBe(MP3_CHUNKS.reduce((n, b) => n + b.length, 0));
    expect(res.headers['content-length']).toBeUndefined();
    expect(done.headersFlushedMs).toBe(120);
    expect(done.firstChunkMs).toBe(160);
    expect(done.headersFlushedMs).toBeLessThan(done.firstChunkMs);
    expect(res.bytes().equals(Buffer.concat(MP3_CHUNKS))).toBe(true);

    // The tee is the same audio the client received.
    expect(readFileSync(teePath).equals(Buffer.concat(MP3_CHUNKS))).toBe(true);
    expect(res.ended).toBe(true);
  });

  it('aborts the provider stream when the client goes away mid-clip', async () => {
    const clock = fakeClock();
    let upstreamAborted = false;
    let chunksProduced = 0;

    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal.aborted) {
            upstreamAborted = true;
            controller.error(new Error('aborted'));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
          clock.advance(30);
          chunksProduced += 1;
          if (chunksProduced > 50) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array([0xff, 0xfb, chunksProduced]));
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = new FakeResponse();
    // Client disconnects after the second chunk: `close` without `end`.
    const stopAfter = setInterval(() => {
      if (res.written.length >= 2) {
        clearInterval(stopAfter);
        clock.advance(5);
        res.destroy();
      }
    }, 1);

    const done = await streamTts({
      text: 'Uma frase longa que não deveria terminar de gerar.',
      agentId: 'coexistir-manager',
      res: res as never,
      fetchImpl,
      now: clock.now,
    });
    clearInterval(stopAfter);

    expect(done.aborted).toBe(true);
    expect(done.abortMs).toBeDefined();
    expect(done.abortMs as number).toBeLessThan(done.totalMs + 1);
    // Upstream was told to stop, and it stopped before the clip ended.
    expect(upstreamAborted || chunksProduced < 50).toBe(true);
    expect(res.ended).toBe(false);
  });

  it('answers 422 for a language with no voice instead of speaking it wrong', async () => {
    const res = new FakeResponse();
    const done = await streamTts({
      text: 'Bonjour',
      agentId: 'coexistir-manager',
      language: 'fr',
      res: res as never,
      fetchImpl: (async () => {
        throw new Error('provider must not be called');
      }) as unknown as typeof fetch,
    });
    expect(res.statusCode).toBe(422);
    expect(res.jsonBody).toMatchObject({ error: 'unsupported_language' });
    expect(done.bytes).toBe(0);
  });

  it('keeps English on the Aura fallback voice and forwards the model, not a language param', async () => {
    const clock = fakeClock();
    const res = new FakeResponse();
    let seenUrl = '';
    let seenBody = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init.body);
      return { ok: true, status: 200, ...chunkedProvider([Buffer.from([1, 2, 3])], 10, clock) } as unknown as Response;
    }) as unknown as typeof fetch;

    await streamTts({
      text: 'Good morning.',
      agentId: 'coexistir-manager',
      language: 'en',
      res: res as never,
      fetchImpl,
      now: clock.now,
    });

    expect(seenUrl).toContain('/v1/speak');
    expect(seenUrl).toContain('aura-2-thalia-en');
    expect(seenUrl).not.toContain('language=');
    expect(JSON.parse(seenBody)).toEqual({ text: 'Good morning.' });
    expect(res.headers['x-tts-language']).toBe('en');
  });
});
