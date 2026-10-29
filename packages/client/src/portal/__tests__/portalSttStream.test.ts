/**
 * portalSttStream.test.ts — the page half of the streaming ear, without a browser.
 *
 * Two failure modes are worth a test each, because both are silent:
 *   - a resampler that drops its remainder: the audio drifts, and word timings
 *     quietly stop matching what was said;
 *   - an audio clock that forgets where the audio was when it was sent: every
 *     stage timing becomes "time since the turn arrived", which always looks good
 *     and means nothing.
 *
 * The socket is faked at `WebSocketImpl`, so the protocol below is exactly the
 * frames the server relay sends (see coexistirVoiceStream.ts).
 */

import {
  AudioClock,
  Pcm16Downsampler,
  createPortalSttStream,
  sttStreamUrl,
  type SttStreamTurnEvent,
} from '../portalSttStream';

/** A WebSocket stand-in: the test decides when the relay "answers". */
class FakeSocket {
  static last: FakeSocket | null = null;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: Array<ArrayBuffer | string> = [];
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    // jsdom's environment in this suite has no setImmediate; a macrotask is
    // enough to model "the socket opens after the constructor returns".
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: ArrayBuffer | string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    setTimeout(() => this.onclose?.({ code: 1000, reason: "test" }), 0);
  }

  /** Push one relay frame at the page. */
  deliver(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

/**
 * Build a stream and hand back the fake socket WITHOUT awaiting the handshake:
 * the test is the relay here, so it has to be able to answer `ready` before
 * anyone waits on it.
 */
const open = (options: Parameters<typeof createPortalSttStream>[0] = {}) => {
  const handle = createPortalSttStream({
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    ...options,
  });
  const connecting = handle.connect();
  const socket = FakeSocket.last as FakeSocket;
  return { handle, socket, connecting };
};

describe('sttStreamUrl', () => {
  it('stays on the page origin and carries no credential', () => {
    const url = sttStreamUrl({ room: 'coexistir', language: 'auto' }, { protocol: 'https:', host: 'door.local' });
    expect(url).toBe('wss://door.local/api/coexistir/voice/stt-stream?room=coexistir&language=auto');
    expect(url).not.toMatch(/token|key/i);
  });

  it('uses ws:// on a plain-http kiosk', () => {
    expect(sttStreamUrl({}, { protocol: 'http:', host: 'localhost:4030' })).toBe(
      'ws://localhost:4030/api/coexistir/voice/stt-stream',
    );
  });
});

describe('Pcm16Downsampler', () => {
  const ramp = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => (from + i) / 1000);

  it('48 kHz -> 16 kHz keeps exactly one third of the samples, every call', () => {
    const down = new Pcm16Downsampler(48000, 16000);
    const total: number[] = [];
    // 2048-sample blocks: the boundary never lines up with the 3:1 grid.
    for (let i = 0; i < 30; i += 1) total.push(down.push(ramp(2048)).length);
    // 30 * 2048 = 61 440 samples in -> 20 480 out (plus at most 2 carried).
    const out = total.reduce((a, b) => a + b, 0);
    expect(out).toBeGreaterThanOrEqual(20479);
    expect(out).toBeLessThanOrEqual(20480);
    // Nothing is lost: what is not emitted is carried, never dropped.
    expect(out + down.pending).toBeGreaterThan(20478);
  });

  it('preserves the carry across blocks so the grid does not shift', () => {
    const down = new Pcm16Downsampler(3, 1); // 3:1, same ratio as 48k->16k
    const first = down.push(Float32Array.from([1, 1, 1, 1]));
    expect(first.length).toBe(1); // one full output, one sample carried
    expect(down.pending).toBe(1);
    const second = down.push(Float32Array.from([1, 1]));
    // 1 carried + 2 new = one more output of mean 1.
    expect(second.length).toBe(1);
    expect(Array.from(second)).toEqual([32767]);
  });

  it('averages the samples it covers (the same filter encodeWav uses)', () => {
    const down = new Pcm16Downsampler(3, 1);
    const out = down.push(Float32Array.from([1, 1, 1, -1, -1, -1]));
    expect(Array.from(out)).toEqual([32767, -32768]);
  });

  it('clips rather than wrapping on a hot signal', () => {
    const down = new Pcm16Downsampler(1, 1);
    expect(Array.from(down.push(Float32Array.from([4, -4])))).toEqual([32767, -32768]);
  });
});

describe('AudioClock', () => {
  it('maps an audio position onto the page clock inside the sent window', () => {
    const clock = new AudioClock();
    clock.push(43, 10_043);
    clock.push(86, 10_090);
    // 64 ms of audio was handed over on the block that ended at 86 ms (10 090).
    expect(clock.toPerf(64)).toBe(10_090 - 22);
    expect(clock.toPerf(43)).toBe(10_043);
  });

  it('extrapolates at 1:1 beyond the last block (real-time capture)', () => {
    const clock = new AudioClock();
    clock.push(43, 10_043);
    expect(clock.toPerf(108)).toBe(10_043 + 65);
  });

  it('has no opinion when nothing was sent', () => {
    expect(new AudioClock().toPerf(10)).toBeNull();
    expect(new AudioClock().toPerf(null)).toBeNull();
  });
});

describe('createPortalSttStream', () => {
  it('becomes ready on the relay handshake and reports the endpointing in force', async () => {
    const { socket, handle, connecting } = open({ now: () => 1000 });
    socket.deliver({ t: 'ready', endpointing: 500, utteranceEndMs: 1000, model: 'nova-3' });
    expect(await connecting).toBe(true);
    expect(handle.ready).toBe(true);
    expect(handle.snapshot()).toMatchObject({ mode: 'stream', endpointing: 500, utteranceEndMs: 1000 });
  });

  it('times out (so the door can fall back) when the relay never answers', async () => {
    const errors: string[] = [];
    const handle = createPortalSttStream({
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      connectTimeoutMs: 20,
      onError: (code) => errors.push(code),
    });
    const ok = await handle.connect();
    expect(ok).toBe(false);
    expect(errors).toContain('timeout');
    expect(handle.snapshot().mode).toBe('off');
  });

  it('closes the socket it abandoned on timeout, so a late ready cannot resurrect it', async () => {
    // The live door's worst silent failure: a socket that loses the handshake
    // race stays open, `ready` lands after the page has already fallen back, the
    // page keeps a relay nobody sends audio to, and no onClose ever reports it.
    const errors: string[] = [];
    const handle = createPortalSttStream({
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      connectTimeoutMs: 10,
      onError: (code) => errors.push(code),
    });
    void handle.connect();
    const abandoned = FakeSocket.last as FakeSocket;
    await new Promise((r) => setTimeout(r, 40));
    expect(abandoned.closed).toBe(true);
    // A `ready` that arrives after the timeout must not flip the page back on.
    abandoned.deliver({ t: 'ready', endpointing: 500, utteranceEndMs: 1000, model: 'nova-3' });
    expect(handle.ready).toBe(false);
    handle.send(new Float32Array(480));
    expect(abandoned.sent).toHaveLength(0);
    expect(errors).toContain('timeout');
  });

  it('counts the audio it could not send while the relay was away', async () => {
    // `unsentBlocks` is the number that tells "nobody spoke" from "the visitor
    // spoke into a socket that was not there" — the live door had neither.
    const handle = createPortalSttStream({
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      connectTimeoutMs: 10,
    });
    handle.send(new Float32Array(480));
    expect(handle.snapshot().unsentBlocks).toBe(1);
    expect(handle.snapshot().bytes).toBe(0);
  });

  it('sends PCM as BINARY and never as text', async () => {
    const { socket, handle, connecting } = open({ now: () => 5000 });
    void connecting;
    socket.deliver({ t: 'ready', endpointing: 500, utteranceEndMs: 1000, model: 'nova-3' });
    handle.send(new Float32Array(480), 5000);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toBeInstanceOf(ArrayBuffer);
    // 480 samples at 48k = 10 ms = 160 samples at 16k = 320 bytes.
    expect((socket.sent[0] as ArrayBuffer).byteLength).toBe(320);
    expect(handle.audioMs).toBe(10);
  });

  it('does not send before the relay says ready (the key/socket may not exist yet)', async () => {
    const { socket, handle, connecting } = open();
    void connecting;
    handle.send(new Float32Array(480));
    expect(socket.sent).toHaveLength(0);
  });

  it('maps the provider word end onto the page clock for the turn', async () => {
    let clockNow = 20_000;
    const turns: SttStreamTurnEvent[] = [];
    const { socket, handle, connecting } = open({
      now: () => clockNow,
      onTurn: (turn) => turns.push(turn),
    });
    void connecting;
    socket.deliver({ t: 'ready', endpointing: 500, utteranceEndMs: 1000, model: 'nova-3' });

    // 1 s of audio sent across 10 blocks, one per 100 ms, starting at 20 000.
    for (let i = 0; i < 10; i += 1) {
      clockNow += 100;
      handle.send(new Float32Array(4800), clockNow);
    }
    // The provider says the last word ended at 0.9 s of audio; the turn arrives
    // 600 ms later (endpointing + relay), i.e. at 21 600.
    clockNow = 21_600;
    socket.deliver({
      t: 'turn',
      turnId: 'turn-1',
      text: 'quais são as tarefas abertas',
      by: 'speech_final',
      language: 'pt',
      sttMs: 600,
      audio: { speechStartMs: 100, lastWordEndMs: 900, atMs: 1000 },
      finals: 1,
      finalsSpanMs: 40,
    });

    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn.text).toBe('quais são as tarefas abertas');
    expect(turn.by).toBe('speech_final');
    // 900 ms of audio landed at page time 20 900 (block 9), so the base is 20 900.
    expect(Math.round(turn.lastWordEndPerf ?? 0)).toBe(20_900);
    expect(turn.atPerf).toBe(21_600);
    // Which is exactly the number the stage waterfall prints.
    expect(Math.round(turn.atPerf - (turn.lastWordEndPerf ?? 0))).toBe(700);
  });

  it('tells the relay to drop a half-heard sentence on reset (mic off / barge-in)', async () => {
    const { socket, handle, connecting } = open();
    void connecting;
    socket.deliver({ t: 'ready', endpointing: 500, utteranceEndMs: 1000, model: 'nova-3' });
    handle.reset();
    expect(socket.sent).toContain(JSON.stringify({ t: 'reset' }));
  });

  it('reports an upstream error without throwing, and closes on mic off', async () => {
    const errors: Array<[string, string]> = [];
    const closes: string[] = [];
    const { socket, handle, connecting } = open({
      onError: (code, message) => errors.push([code, message]),
      onClose: (reason) => closes.push(reason),
    });
    void connecting;
    socket.deliver({ t: 'ready', endpointing: 500, utteranceEndMs: 1000, model: 'nova-3' });
    socket.deliver({ t: 'error', code: 'provider', message: 'socket died' });
    expect(errors).toEqual([['provider', 'socket died']]);

    handle.close();
    expect(handle.ready).toBe(false);
    expect(handle.snapshot().closed).toBe(true);
  });
});
