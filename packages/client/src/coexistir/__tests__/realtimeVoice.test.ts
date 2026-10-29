/**
 * realtimeVoice.test.ts — progressive playback + barge-in, headless.
 *
 * Fakes the Web Audio graph and the fetch body so the CONTRACT is testable in
 * jsdom:
 * - a chunk is decoded and scheduled while the provider is still streaming
 *   (progressive, not "download then play");
 * - `stop()` aborts the HTTP request (the same call the server turns into a
 *   Deepgram abort) and reports how much audio had played.
 */

import { RealtimeVoicePlayer, clearVoiceTrace, readVoiceTrace } from '../realtimeVoice';
import type { AudioBufferLike, AudioBufferSourceLike, AudioContextLike } from '../realtimeVoice';

/** 6 KB per second: roughly Deepgram Flux's 48 kbps output. */
const BYTES_PER_SECOND = 6000;

class FakeContext implements AudioContextLike {
  state = 'running';
  currentTime = 0;
  destination = { name: 'destination' };
  started: Array<{ when: number; duration: number; stopped: boolean }> = [];
  decodeCalls = 0;
  buffersCreated = 0;
  sources: AudioBufferSourceLike[] = [];

  advance(seconds: number) {
    this.currentTime += seconds;
  }

  async resume() {
    this.state = 'running';
  }

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    this.decodeCalls += 1;
    const bytes = data.byteLength;
    // A trailing partial frame is not decodable — mirrors Chrome's behaviour.
    if (bytes < 400) throw new Error('EncodingError: partial frame');
    const duration = bytes / BYTES_PER_SECOND;
    const sampleRate = 1000;
    return {
      duration,
      length: Math.round(duration * sampleRate),
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(Math.round(duration * sampleRate)),
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
    this.buffersCreated += 1;
    return {
      duration: length / sampleRate,
      length,
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(length),
      copyToChannel: () => undefined,
    };
  }

  createBufferSource(): AudioBufferSourceLike {
    // Capture the arrays, not `this` — MSE-style graphs outlive the call.
    const started = this.started;
    const sources = this.sources;
    let index = -1;
    const source: AudioBufferSourceLike = {
      buffer: null,
      connect: () => source,
      start: (when = 0) => {
        started.push({ when, duration: source.buffer?.duration ?? 0, stopped: false });
        index = started.length - 1;
      },
      stop: () => {
        if (index >= 0) started[index].stopped = true;
      },
      onended: null,
      disconnect: () => undefined,
    };
    sources.push(source);
    return source;
  }

  /** Simulate the last scheduled buffer finishing (native onended). */
  fireEnded() {
    const last = this.sources[this.sources.length - 1];
    last?.onended?.();
  }
}

function fakeAudio() {
  const audio: any = {
    currentTime: 0,
    paused: true,
    src: '',
    onended: null,
    play: jest.fn(async () => {
      audio.paused = false;
    }),
    pause() {
      audio.paused = true;
    },
    removeAttribute() {
      audio.src = '';
    },
    load() {
      /* no-op */
    },
  };
  return audio;
}

/**
 * A response whose body yields `sizes` chunks with `gapMs` between them.
 * Hand-rolled (no web-stream/Response globals) so it runs under jsdom.
 */
function streamingResponse(sizes: number[], gapMs = 8) {
  let i = 0;
  const headers: Record<string, string> = {
    'X-TTS-Language': 'pt-BR',
    'X-TTS-Model-Id': 'flux-mariana-pt',
    'X-Turn-Id': 't_test',
  };
  const body = {
    getReader: () => ({
      read: async () => {
        if (i >= sizes.length) return { done: true, value: undefined };
        await new Promise((r) => setTimeout(r, gapMs));
        const value = new Uint8Array(sizes[i]).fill(7);
        i += 1;
        return { done: false, value };
      },
      cancel: async () => undefined,
    }),
  };
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? null },
    body,
  } as unknown as Response;
}

beforeEach(() => clearVoiceTrace());

describe('RealtimeVoicePlayer', () => {
  it('schedules audio while the stream is still arriving (progressive)', async () => {
    const ctx = new FakeContext();
    let aborted = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      (init.signal as AbortSignal).addEventListener('abort', () => {
        aborted = true;
      });
      // 20 chunks × 900B ≈ 3s of audio, delivered over ~160ms.
      return streamingResponse(new Array(20).fill(900), 8);
    }) as unknown as typeof fetch;

    const player = new RealtimeVoicePlayer({
      fetchImpl,
      createAudioContext: () => ctx,
      createAudio: () => fakeAudio() as unknown as HTMLAudioElement,
      apiBase: '',
    });

    const startedAt = Date.now();
    const result = await player.speak('Bom dia, Ana.', { language: 'pt-BR' });
    const resolveMs = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('progressive');
    expect(result.modelId).toBe('flux-mariana-pt');
    expect(result.turnId).toBe('t_test');
    expect(result.firstChunkMs).toBeGreaterThanOrEqual(0);
    expect(result.audioStartMs).toBeGreaterThanOrEqual(0);
    // Playback was scheduled before the clip finished streaming (~160ms of
    // chunks): this is the whole point of the bridge.
    expect(resolveMs).toBeLessThan(320);

    await new Promise((r) => setTimeout(r, 400));
    const trace = readVoiceTrace();
    const kinds = trace.map((e) => e.kind);
    expect(kinds[0]).toBe('request');
    expect(kinds).toContain('transport');
    expect(kinds.indexOf('first-chunk')).toBeGreaterThan(-1);
    expect(kinds.indexOf('audio-start')).toBeGreaterThan(kinds.indexOf('first-chunk'));
    expect(kinds.indexOf('audio-start')).toBeLessThan(kinds.lastIndexOf('audio-start') + 1);
    expect(ctx.started.length).toBeGreaterThan(1);
    // Scheduled back-to-back, never overlapping and never going backwards.
    for (let i = 1; i < ctx.started.length; i += 1) {
      expect(ctx.started[i].when).toBeGreaterThanOrEqual(ctx.started[i - 1].when + ctx.started[i - 1].duration - 0.01);
    }
    expect(aborted).toBe(false);

    ctx.fireEnded();
    expect(readVoiceTrace().some((e) => e.kind === 'ended')).toBe(true);
  });

  it('does not let a superseded stream end the new turn', async () => {
    const ctx = new FakeContext();
    let releaseFirst: (() => void) | null = null;
    let call = 0;

    const firstResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => {
          let delivered = false;
          return {
            read: async () => {
              if (!delivered) {
                delivered = true;
                return { done: false, value: new Uint8Array(900).fill(7) };
              }
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
              return { done: true, value: undefined };
            },
            cancel: async () => {
              releaseFirst?.();
            },
          };
        },
      },
    } as unknown as Response;

    const fetchImpl = (async () => {
      call += 1;
      // The second request streams normally; the first is held open until the
      // second turn supersedes it.
      return call === 1 ? firstResponse : streamingResponse(new Array(12).fill(900), 6);
    }) as unknown as typeof fetch;

    const player = new RealtimeVoicePlayer({
      fetchImpl,
      createAudioContext: () => ctx,
      createAudio: () => fakeAudio() as unknown as HTMLAudioElement,
    });

    await player.speak('primeira resposta', { language: 'pt-BR' });
    clearVoiceTrace();
    await player.speak('segunda resposta', { language: 'pt-BR' });

    // Let the first stream's consume loop observe its close. Before the turn
    // guard, it called scheduleEnd() on the SECOND turn and ended it instantly.
    await new Promise((r) => setTimeout(r, 250));
    expect(readVoiceTrace().some((e) => e.kind === 'ended')).toBe(false);
    expect(player.isActive).toBe(true);

    ctx.fireEnded();
    expect(readVoiceTrace().some((e) => e.kind === 'ended')).toBe(true);
    expect(player.isActive).toBe(false);
  });

  it('stops playback, aborts the stream and reports the audio heard', async () => {
    const ctx = new FakeContext();
    let aborted = false;
    let serverSawClose = false;

    const fetchImpl = (async (_url: string, init: RequestInit) => {
      (init.signal as AbortSignal).addEventListener('abort', () => {
        aborted = true;
        setTimeout(() => {
          serverSawClose = true;
        }, 5);
      });
      return streamingResponse(new Array(200).fill(900), 10); // long clip
    }) as unknown as typeof fetch;

    const player = new RealtimeVoicePlayer({
      fetchImpl,
      createAudioContext: () => ctx,
      createAudio: () => fakeAudio() as unknown as HTMLAudioElement,
    });

    await player.speak('Uma resposta longa que vai ser interrompida.', { language: 'pt-BR' });
    ctx.advance(0.6); // 600ms of context time

    const t0 = Date.now();
    const stop = player.stop('barge-in');
    const stopMs = Date.now() - t0;

    expect(stop.aborted).toBe(true);
    // `playedMs` is measured from the scheduled start, which is 120ms into the
    // future (the first-buffer lead / jitter buffer), so 600ms of context time is
    // 480ms of audio the listener actually heard.
    expect(stop.playedMs).toBeGreaterThanOrEqual(450);
    expect(stopMs).toBeLessThan(100);
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(serverSawClose).toBe(true);
    expect(ctx.started.every((s) => s.stopped)).toBe(true);

    const stopEvent = readVoiceTrace().find((e) => e.kind === 'stop')!;
    expect(stopEvent.reason).toBe('barge-in');
    expect(Number(stopEvent.playedMs)).toBeGreaterThanOrEqual(450);
  });

  it('reports unsupported language without pretending to play', async () => {
    const player = new RealtimeVoicePlayer({
      fetchImpl: (async () => ({
        ok: false,
        status: 422,
        headers: { get: () => null },
        body: null,
      })) as unknown as typeof fetch,
      createAudioContext: () => new FakeContext(),
      createAudio: () => fakeAudio() as unknown as HTMLAudioElement,
    });
    const result = await player.speak('Bonjour', { language: 'fr' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported');
    expect(result.status).toBe(422);
  });

  it('falls back to a buffered clip when Web Audio is unavailable', async () => {
    const audio = fakeAudio();
    const player = new RealtimeVoicePlayer({
      fetchImpl: (async () => streamingResponse([512, 512], 5)) as unknown as typeof fetch,
      createAudioContext: () => null,
      createAudio: () => audio as unknown as HTMLAudioElement,
      createObjectUrl: () => 'blob:whole',
      revokeObjectUrl: () => undefined,
    });
    const result = await player.speak('Bom dia.', { language: 'pt-BR' });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('buffered');
    await new Promise((r) => setTimeout(r, 120));
    expect(audio.src).toBe('blob:whole');
  });
});
