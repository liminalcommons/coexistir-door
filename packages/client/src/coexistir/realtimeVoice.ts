/**
 * realtimeVoice — progressive playback + barge-in for agent replies.
 *
 * The server streams MP3 chunks as Deepgram produces them. This module is the
 * client half: it decodes each arriving chunk with the Web Audio API and
 * schedules it back-to-back on the audio clock, so the first syllable is audible
 * roughly 0.3–0.6s after the request instead of after the whole clip (the old
 * `await response.blob()` path).
 *
 * Why Web Audio and not MediaSource: MSE needs an audio pipeline that several
 * Chromium builds (headless included) never open for `audio/mpeg` — probed on
 * the rig, `MediaSource.readyState` stays `closed` forever and `addSourceBuffer`
 * throws `InvalidStateError`, while `AudioContext.decodeAudioData` on the very
 * same bytes plays fine. Decode-as-you-go is one code path that works in both.
 *
 * Gapless: every arriving chunk re-decodes the WHOLE buffer and only the audio
 * past `decodedSeconds` is scheduled, so there is exactly one decoder priming
 * delay per turn and no click at chunk boundaries.
 *
 * Barge-in contract: `stop()` must kill BOTH ends within 1.5s —
 * 1. local: stop the scheduled sources and drop the queue;
 * 2. remote: abort the fetch, which closes the HTTP request, which makes the
 *    server abort its Deepgram call (see `ttsStream.ts`).
 * A stop that only mutes the speaker keeps burning tokens and keeps the
 * provider talking, which is why the abort controller is held here.
 *
 * Every step is traced into `globalThis.__CASTALIA_VOICE_TRACE__` so the bridge
 * can be timed from a real browser instead of by ear.
 */

export const VOICE_TRACE_KEY = '__CASTALIA_VOICE_TRACE__';
export const VOICE_LAST_KEY = '__CASTALIA_VOICE_LAST__';

export type VoiceTransportMode = 'progressive' | 'buffered';

export interface VoiceTraceEvent {
  kind:
    | 'request'
    | 'headers'
    | 'first-chunk'
    | 'transport'
    | 'decode'
    | 'audio-start'
    | 'ended'
    | 'stop'
    | 'error'
    | 'blocked';
  /** performance.now() of the event. */
  t: number;
  /** ms since the request started (0 for 'request'). */
  elapsedMs: number;
  [key: string]: unknown;
}

export interface RealtimeSpeakOptions {
  language?: string;
  agentId?: string;
  turnId?: string;
  kind?: 'filler' | 'answer';
  /** Override the stream route (tests). */
  path?: string;
}

export interface RealtimeStartResult {
  ok: boolean;
  mode: VoiceTransportMode;
  reason?: 'empty' | 'http' | 'unsupported' | 'blocked' | 'error' | 'disabled';
  status?: number;
  language?: string;
  modelId?: string;
  turnId?: string;
  /** Request start -> first body chunk (network + server flush). */
  firstChunkMs?: number;
  /** Request start -> response headers (client TTFB). */
  ttfbMs?: number;
  /** Request start -> audio clock started moving. */
  audioStartMs?: number | null;
  bytes?: number;
}

export interface StopResult {
  aborted: boolean;
  reason: string;
  /** How much audio the listener actually heard before the cut. */
  playedMs: number;
  /** How long the local teardown took (should be single-digit ms). */
  teardownMs: number;
}

/** The slice of the Web Audio API this module uses (fakeable in tests). */
export interface AudioBufferLike {
  duration: number;
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
  copyToChannel?(source: Float32Array, channel: number): void;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(): void;
  onended: (() => void) | null;
  disconnect?(): void;
}

/**
 * The slice of AnalyserNode used for lip sync. Optional: test doubles and
 * browsers without Web Audio simply leave the mouth closed.
 */
export interface AnalyserLike {
  fftSize: number;
  smoothingTimeConstant: number;
  connect(destination: unknown): unknown;
  disconnect?(): void;
  getFloatTimeDomainData(array: Float32Array): void;
}

/**
 * The slice of GainNode this module uses: every scheduled buffer gets a short
 * fade so chunk splices cannot click (the decode boundary is not sample-exact
 * when a codec is decoded in prefixes).
 */
export interface GainLike {
  gain: {
    value: number;
    setValueAtTime?(value: number, when: number): void;
    linearRampToValueAtTime?(value: number, when: number): void;
  };
  connect?(destination: unknown): unknown;
  disconnect?(): void;
}

export interface AudioContextLike {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  createAnalyser?(): AnalyserLike;
  createGain?(): GainLike;
  /** Rig instrumentation only: taps what the player is actually emitting. */
  createMediaStreamDestination?(): { stream: MediaStream };
  close?(): Promise<void>;
}

export interface RealtimeVoiceDeps {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected so jsdom/tests can supply a fake element (buffered fallback). */
  createAudio?: () => HTMLAudioElement;
  /** Injected so tests can fake the audio graph; null disables progressive. */
  createAudioContext?: () => AudioContextLike | null;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
  onStarted?: (result: RealtimeStartResult) => void;
}

function browserApiBase(): string {
  const base = (globalThis as unknown as { __CASTALIA_API_BASE__?: unknown }).__CASTALIA_API_BASE__;
  return typeof base === 'string' ? base : '';
}

function trace(event: VoiceTraceEvent): void {
  const store = globalThis as unknown as Record<string, unknown>;
  const list = (store[VOICE_TRACE_KEY] as VoiceTraceEvent[]) || [];
  list.push(event);
  // Bounded ring: a long room must not grow memory without limit.
  if (list.length > 400) list.splice(0, list.length - 400);
  store[VOICE_TRACE_KEY] = list;
  store[VOICE_LAST_KEY] = event;
}

export function readVoiceTrace(): VoiceTraceEvent[] {
  return ((globalThis as unknown as Record<string, unknown>)[VOICE_TRACE_KEY] as VoiceTraceEvent[]) || [];
}

export function clearVoiceTrace(): void {
  (globalThis as unknown as Record<string, unknown>)[VOICE_TRACE_KEY] = [];
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * How much audio must already be scheduled before a pump is allowed to skip.
 *
 * The player re-decodes the whole accumulated reply on every pump (that is what
 * keeps prefix decodes sample-exact — measured identical to a one-shot decode).
 * Pumping on every ~70 ms network chunk therefore decodes the reply ~200 times
 * over: a 17.6 s answer cost ~2000 s of MP3 decoding, and on a phone the audio
 * thread starved — the rig recorded 51 dropouts / 5.9 s of silence inside one
 * reply. Decoding one second ahead keeps the queue seamless while cutting the
 * work ~17x.
 */
const PUMP_LOW_WATER_S = 1.25;

/** The jitter buffer in front of the first syllable of a reply. */
const FIRST_BUFFER_LEAD_S = 0.12;

/**
 * Audio to accumulate before the first buffer is scheduled.
 *
 * Deepgram produces roughly realtime, so a player that starts on the first
 * ~70 ms chunk runs for the whole reply with a queue dozens of milliseconds
 * deep: one slow decode and the audio thread has nothing to read, which is
 * audible as a stutter. Waiting for a third of a second costs that much latency
 * once and gives every decode since real slack.
 */
const PREBUFFER_S = 0.35;

export class RealtimeVoicePlayer {
  private deps: RealtimeVoiceDeps;
  private controller: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private ctx: AudioContextLike | null = null;
  private analyser: AnalyserLike | null = null;
  private levelBuffer: Float32Array | null = null;
  private smoothedLevel = 0;
  private sources: AudioBufferSourceLike[] = [];
  /** Last time the network produced a chunk (end-of-speech watchdog). */
  private lastChunkAt = 0;
  private endWatchdog: ReturnType<typeof setTimeout> | null = null;
  private raw: Uint8Array = new Uint8Array(0);
  private decodedSeconds = 0;
  private scheduledEnd = 0;
  private startedAtCtx: number | null = null;
  private decoding = false;
  private dirty = false;
  /** Silence inserted between buffers (decode slower than realtime) + count. */
  private underruns = 0;
  private gaps: number[] = [];
  private scheduledCount = 0;
  private captureDest: { stream: MediaStream } | null = null;
  /** Retry tick: a deep queue keeps its bytes, and this decodes them in time. */
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  /** True once the HTTP body is closed, so a short reply can still be played. */
  private streamDone = false;
  private ended = false;
  private endedResolvers: Array<() => void> = [];
  /** Bumped on stop/supersede so an in-flight decode cannot schedule audio after the cut. */
  private turn = 0;
  private requestStartedAt = 0;
  private lastResult: RealtimeStartResult | null = null;
  /**
   * Audio may not start before a user gesture. A door screen that builds an
   * AudioContext on load gets a suspended context and Chrome logs
   * "AudioContext was not allowed to start"; the first reply is then silent.
   * Creation is gated on unlock(), which the TALK tap calls.
   */
  private unlocked: boolean;

  constructor(deps: RealtimeVoiceDeps = {}) {
    this.deps = deps;
    // An injected factory means the host owns the audio policy (tests/embeds).
    this.unlocked = typeof deps.createAudioContext === 'function';
  }

  get result(): RealtimeStartResult | null {
    return this.lastResult;
  }

  private now(): number {
    if (this.deps.now) return this.deps.now();
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private apiBase(): string {
    return this.deps.apiBase ?? browserApiBase();
  }

  private emit(kind: VoiceTraceEvent['kind'], extra: Record<string, unknown> = {}): void {
    const t = this.now();
    // Event kind wins over any same-named payload field ('step', never 'kind').
    trace({ ...extra, kind, t, elapsedMs: Math.round(t - this.requestStartedAt) });
  }

  /**
   * Start one streamed reply, or fall back to buffering when the browser has no
   * Web Audio. Resolves once audio is playing (not when the clip ends).
   */
  async speak(text: string, options: RealtimeSpeakOptions = {}): Promise<RealtimeStartResult> {
    const reply = (text || '').trim();
    if (!reply) return { ok: false, mode: 'progressive', reason: 'empty' };

    this.stop('superseded');
    this.turn += 1;

    const fetchImpl = this.deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) return { ok: false, mode: 'progressive', reason: 'error' };

    this.requestStartedAt = this.now();
    this.ended = false;
    this.raw = new Uint8Array(0);
    this.decodedSeconds = 0;
    this.scheduledEnd = 0;
    this.startedAtCtx = null;
    this.sources = [];
    this.smoothedLevel = 0;
    this.lastChunkAt = this.now();
    this.underruns = 0;
    this.gaps = [];
    this.scheduledCount = 0;
    this.streamDone = false;

    const controller = new AbortController();
    this.controller = controller;
    this.emit('request', {
      textLength: reply.length,
      language: options.language || null,
      turnId: options.turnId || null,
      step: options.kind || 'answer',
    });

    let response: Response;
    try {
      response = await fetchImpl(`${this.apiBase()}${options.path || '/api/coexistir/voice/stream'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: reply,
          language: options.language,
          agentId: options.agentId,
          turnId: options.turnId,
          kind: options.kind || 'answer',
        }),
        signal: controller.signal,
      });
    } catch {
      this.emit('error', { stage: 'fetch' });
      return { ok: false, mode: 'progressive', reason: 'error' };
    }

    const ttfbMs = Math.round(this.now() - this.requestStartedAt);
    this.emit('headers', { status: response.status, ttfbMs });

    if (response.status === 422) {
      this.emit('error', { stage: 'unsupported', status: 422 });
      return { ok: false, mode: 'progressive', reason: 'unsupported', status: 422 };
    }
    if (!response.ok || !response.body) {
      this.emit('error', { stage: 'http', status: response.status });
      return { ok: false, mode: 'progressive', reason: 'http', status: response.status };
    }

    const language = response.headers?.get?.('X-TTS-Language') || options.language || undefined;
    const modelId = response.headers?.get?.('X-TTS-Model-Id') || undefined;
    const turnId = response.headers?.get?.('X-Turn-Id') || options.turnId || undefined;

    const ctx = this.ensureContext();
    const mode: VoiceTransportMode = ctx ? 'progressive' : 'buffered';
    this.emit('transport', { mode });
    // A live stream always has a tick that can feed the queue, so a chunk that
    // arrives while the queue is deep is decoded before the queue drains.
    if (mode === 'progressive') this.startPumpTimer();

    const chunks: ArrayBuffer[] = [];
    let firstChunkMs: number | undefined;
    let signalFirstChunk: (() => void) | null = null;
    const firstChunkArrived = new Promise<void>((resolve) => {
      signalFirstChunk = resolve;
    });
    let signalEnded: (() => void) | null = null;
    const endedPromise = new Promise<void>((resolve) => {
      signalEnded = resolve;
    });
    const markEnded = () => {
      signalEnded?.();
      signalEnded = null;
    };

    const consume = async () => {
      const reader = response.body!.getReader();
      this.reader = reader;
      const turn = this.turn;
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // A chunk can still land after a barge-in; never feed it to the decoder.
        if (turn !== this.turn) return;
        if (!value) continue;
        this.lastChunkAt = this.now();
        const copy = new Uint8Array(value.length);
        copy.set(value);
        chunks.push(copy.buffer);
        if (first) {
          first = false;
          firstChunkMs = Math.round(this.now() - this.requestStartedAt);
          this.emit('first-chunk', { firstChunkMs, bytes: copy.length });
          signalFirstChunk?.();
          signalFirstChunk = null;
        }
        if (mode === 'progressive') {
          this.raw = concatBytes(this.raw, copy);
          void this.pump();
        }
      }

      // A newer turn superseded this stream while it was closing. Its tail
      // must never pump into / end the NEW turn's audio (this used to end the
      // answer the instant the previous filler's body closed).
      if (turn !== this.turn) return;

      if (mode === 'progressive') {
        this.streamDone = true;
        await this.pump(true); // final decode of whatever the tail holds
        this.scheduleEnd(markEnded, turn);
        await Promise.race([endedPromise, new Promise((r) => setTimeout(r, 8000))]);
      } else {
        // Buffered fallback: the clip is only playable once it is complete.
        const blob = new Blob(chunks, { type: 'audio/mpeg' });
        const url = (this.deps.createObjectUrl || ((b: Blob) => URL.createObjectURL(b)))(blob);
        this.objectUrl = url;
        const audio = (this.deps.createAudio || (() => new Audio()))();
        this.audio = audio;
        audio.src = url;
        audio.onended = () => this.finishTurn();
        try {
          await audio.play();
        } catch {
          this.emit('blocked', {});
        }
      }
    };

    const playback = consume().catch(() => {
      if (controller.signal.aborted) return; // superseded / barged in on
      this.emit('error', { stage: 'stream' });
      this.deps.onError?.('stream');
    });

    // "Speaking" should mean audio is flowing: wait for the first chunk (or give
    // up at 1.2s) AND, in progressive mode, for the first scheduled buffer.
    await Promise.race([firstChunkArrived, new Promise((r) => setTimeout(r, 1200))]);
    if (mode === 'progressive') {
      await Promise.race([
        new Promise<void>((resolve) => {
          const poll = () => (this.startedAtCtx !== null ? resolve() : setTimeout(poll, 20));
          poll();
        }),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }

    const bytesSoFar = chunks.reduce((n, c) => n + c.byteLength, 0);
    const result: RealtimeStartResult = {
      ok: true,
      mode,
      language,
      modelId,
      turnId,
      ttfbMs,
      firstChunkMs,
      audioStartMs: this.startedAtCtx === null ? null : Math.round(this.now() - this.requestStartedAt),
      bytes: bytesSoFar,
    };
    this.lastResult = result;
    this.deps.onStarted?.(result);
    void playback;
    return result;
  }

  /**
   * Unlock browser audio from a real user gesture (the door's TALK tap).
   * Browsers refuse to start an AudioContext otherwise, which silently swallows
   * the first reply; calling this first makes the first tap audible.
   */
  async unlock(): Promise<boolean> {
    this.unlocked = true;
    const ctx = this.ensureContext();
    if (!ctx) return false;
    try {
      await ctx.resume();
    } catch {
      /* resume can reject outside a gesture; the next tap retries */
    }
    return ctx.state === 'running';
  }

  private ensureContext(): AudioContextLike | null {
    if (this.ctx) {
      void this.ctx.resume?.().catch?.(() => undefined);
      this.ensureAnalyser();
      return this.ctx;
    }
    // No gesture yet: creating a context here only earns a console warning and
    // a silent, suspended graph. Speak through the buffered fallback instead.
    if (!this.unlocked) return null;
    const factory =
      this.deps.createAudioContext ||
      (typeof AudioContext !== 'undefined' ? () => new AudioContext() as unknown as AudioContextLike : null);
    if (!factory) return null;
    try {
      this.ctx = factory();
      void this.ctx?.resume?.().catch?.(() => undefined);
      this.ensureAnalyser();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /**
   * A pass-through analyser on the output graph. The streamed TTS is scheduled
   * as AudioBufferSources (not an <audio> element), so this is the only place
   * the rig can read the amplitude it is actually hearing.
   */
  private ensureAnalyser(): void {
    if (this.analyser || !this.ctx) return;
    if (typeof this.ctx.createAnalyser !== 'function') return;
    try {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      analyser.connect(this.ctx.destination);
      this.analyser = analyser;
      this.levelBuffer = new Float32Array(analyser.fftSize);
    } catch {
      // A browser that refuses an analyser must not refuse to speak.
      this.analyser = null;
      this.levelBuffer = null;
    }
  }

  /**
   * Rig instrumentation: a MediaStream carrying exactly what the door is
   * playing. Lets a probe record the output and measure dropouts / splices
   * instead of arguing about "it sounds choppy".
   */
  captureStream(): MediaStream | null {
    const ctx = this.ensureContext();
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
    if (this.captureDest) return this.captureDest.stream;
    try {
      this.ensureAnalyser();
      const dest = ctx.createMediaStreamDestination();
      const node: unknown = this.analyser ?? null;
      if (node && typeof (node as { connect?: unknown }).connect === 'function') {
        (node as { connect(d: unknown): unknown }).connect(dest);
      }
      this.captureDest = dest;
      return dest.stream;
    } catch {
      return null;
    }
  }

  /** Playback continuity counters (underruns = silence inserted between buffers). */
  playbackStats(): { underruns: number; maxGapMs: number; chunks: number } {
    return {
      underruns: this.underruns,
      maxGapMs: Math.round(Math.max(0, ...this.gaps) * 1000),
      chunks: this.scheduledCount,
    };
  }

  /**
   * Current output amplitude, 0..1, measured from the analyser the voice is
   * playing through. Returns 0 when nothing is scheduled, and decays smoothly
   * on a barge-in so the rig's mouth does not snap shut mid-syllable.
   */
  level(): number {
    const analyser = this.analyser;
    const buffer = this.levelBuffer;
    if (!analyser || !buffer || this.sources.length === 0) {
      this.smoothedLevel *= 0.6;
      return this.smoothedLevel < 0.01 ? 0 : this.smoothedLevel;
    }
    try {
      analyser.getFloatTimeDomainData(buffer as unknown as Float32Array<ArrayBuffer>);
    } catch {
      return 0;
    }
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const sample = buffer[i];
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / buffer.length);
    // Same curve as audioMouth: speech RMS sits around 0.02–0.15.
    const target = Math.min(1, Math.max(0, (rms - 0.008) * 7));
    const smoothing = target > this.smoothedLevel ? 0.6 : 0.22;
    this.smoothedLevel += (target - this.smoothedLevel) * smoothing;
    return this.smoothedLevel;
  }

  /**
   * Decode the accumulated bytes and schedule only the audio past what has
   * already been queued. Re-decoding the whole buffer keeps one priming delay
   * per turn and makes chunk boundaries inaudible (verified: a prefix decode is
   * sample-identical to a one-shot decode of the same stream).
   */
  private async pump(force = false): Promise<void> {
    if (!this.ctx) return;
    if (this.decoding) {
      this.dirty = true;
      return;
    }
    if (!force && !this.needsPump()) return;
    this.decoding = true;
    try {
      do {
        this.dirty = false;
        await this.decodeOnce();
      } while (this.dirty && (force || this.needsPump()));
    } finally {
      this.decoding = false;
    }
  }

  /**
   * Is the queue shallow enough that another decode is worth its cost? A deep
   * queue keeps its bytes until the retry tick; decoding every 70 ms chunk is
   * what starved the audio thread and made the voice stutter.
   */
  private needsPump(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (this.scheduledEnd === 0) return true;
    return this.scheduledEnd - ctx.currentTime < PUMP_LOW_WATER_S;
  }

  /** While a stream is live, keep checking whether the queue needs feeding. */
  private startPumpTimer(): void {
    if (this.pumpTimer !== null) return;
    if (typeof setInterval !== 'function') return;
    this.pumpTimer = setInterval(() => {
      if (this.needsPump()) void this.pump();
    }, 250);
  }

  private stopPumpTimer(): void {
    if (this.pumpTimer === null) return;
    clearInterval(this.pumpTimer);
    this.pumpTimer = null;
  }

  private async decodeOnce(): Promise<void> {
    const ctx = this.ctx;
    const turn = this.turn;
    if (!ctx || this.raw.length === 0) return;
    const snapshot = this.raw.slice(); // decodeAudioData detaches its input
    let buffer: AudioBufferLike;
    const decodeStartedAt = this.now();
    try {
      buffer = await ctx.decodeAudioData(snapshot.buffer);
    } catch {
      // A partial MP3 frame at the tail: the next chunk completes it.
      return;
    }
    // Barge-in landed while we were decoding: never start talking again.
    if (turn !== this.turn) return;
    const total = buffer.duration;
    if (!(total > this.decodedSeconds + 0.005)) return;
    // Jitter buffer: hold the first buffer until a third of a second exists.
    // The stream ends regardless, so a short reply still plays on the final pump.
    if (this.startedAtCtx === null && !this.streamDone && total < PREBUFFER_S) {
      this.emit('prebuffer', { seconds: Number(total.toFixed(3)) });
      return;
    }

    const sampleRate = buffer.sampleRate;
    const startSample = Math.floor(this.decodedSeconds * sampleRate);
    const length = buffer.length - startSample;
    if (length <= 0) {
      this.decodedSeconds = total;
      return;
    }

    const tail = ctx.createBuffer(buffer.numberOfChannels, length, sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel).subarray(startSample);
      if (typeof tail.copyToChannel === 'function') tail.copyToChannel(data, channel);
    }

    const source = ctx.createBufferSource();
    source.buffer = tail;
    source.connect(this.analyser ?? ctx.destination);
    // Chained scheduling, not `now + 30 ms`: the next buffer starts exactly
    // where the previous one ends. A drained queue is an underrun, and it is
    // counted instead of being silently glitched over.
    const first = this.startedAtCtx === null;
    const prevEnd = this.scheduledEnd;
    const when = first
      ? ctx.currentTime + FIRST_BUFFER_LEAD_S
      : Math.max(prevEnd, ctx.currentTime + 0.02);
    if (!first && prevEnd > 0) {
      const gap = Math.max(0, when - prevEnd);
      this.gaps.push(gap);
      if (gap > 0.005) this.underruns += 1;
    }
    source.start(when);
    this.scheduledEnd = when + tail.duration;
    this.scheduledCount += 1;
    this.sources.push(source);
    this.decodedSeconds = total;
    this.emit('decode', {
      decodedSeconds: Number(total.toFixed(3)),
      scheduledAt: Number(when.toFixed(3)),
      chunkSeconds: Number(tail.duration.toFixed(3)),
      decodeMs: Math.round(this.now() - decodeStartedAt),
      leadMs: Math.round(Math.max(0, when - ctx.currentTime) * 1000),
    });
    this.armEndWatchdog(this.turn);

    if (this.startedAtCtx === null) {
      this.startedAtCtx = when;
      this.emit('audio-start', {
        audioStartMs: Math.round(this.now() - this.requestStartedAt),
        scheduledAt: Number(when.toFixed(3)),
      });
    }
  }

  /** Fire `ended` when the last scheduled buffer finishes. */
  private scheduleEnd(markEnded: () => void, turn: number = this.turn): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const last = this.sources[this.sources.length - 1];
    if (!last) {
      markEnded();
      this.finishTurn();
      return;
    }
    last.onended = () => {
      if (turn !== this.turn) return;
      markEnded();
      this.finishTurn();
    };
    // Belt and braces: a source that never fires onended must not wedge the UI.
    const remainingMs = Math.max(0, (this.scheduledEnd - ctx.currentTime) * 1000) + 150;
    setTimeout(() => {
      if (turn !== this.turn) return;
      markEnded();
      this.finishTurn();
    }, remainingMs);
  }

  /**
   * End-of-speech watchdog.
   *
   * The player used to close a turn only when the HTTP body ended. A Deepgram
   * stream can keep the connection open after the last audio chunk, which left
   * the room (and the portal) "speaking" for tens of seconds with nothing
   * playing. This fires once the scheduled audio is exhausted AND the network
   * has been quiet long enough that no more chunks are plausible.
   */
  private armEndWatchdog(turn: number = this.turn): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.endWatchdog !== null) {
      clearTimeout(this.endWatchdog);
      this.endWatchdog = null;
    }
    const remainingMs = Math.max(0, (this.scheduledEnd - ctx.currentTime) * 1000) + 450;
    this.endWatchdog = setTimeout(() => {
      this.endWatchdog = null;
      if (turn !== this.turn) return;
      if (this.ended || !this.ctx) return;
      const quietFor = this.now() - this.lastChunkAt;
      if (quietFor < 4000) {
        this.armEndWatchdog(this.turn);
        return;
      }
      if (this.ctx.currentTime >= this.scheduledEnd - 0.05) {
        this.finishTurn();
      } else {
        this.armEndWatchdog(this.turn);
      }
    }, remainingMs);
  }

  private finishTurn(): void {
    if (this.ended) return;
    this.ended = true;
    this.stopPumpTimer();
    if (this.endWatchdog !== null) {
      clearTimeout(this.endWatchdog);
      this.endWatchdog = null;
    }
    this.emit('ended', {});
    const resolvers = this.endedResolvers;
    this.endedResolvers = [];
    for (const resolve of resolvers) resolve();
    this.deps.onEnded?.();
  }

  /** Resolves when this turn's audio finishes (or is cut). Used to sequence steps. */
  whenEnded(timeoutMs = 20000): Promise<void> {
    if (this.ended || !this.isActive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.endedResolvers.push(resolve);
      setTimeout(resolve, timeoutMs);
    });
  }

  /** How much of the reply the listener has actually heard, in ms. */
  private playedMs(): number {
    if (!this.ctx || this.startedAtCtx === null) return 0;
    return Math.max(0, (this.ctx.currentTime - this.startedAtCtx) * 1000);
  }

  /**
   * Barge-in. Aborts the HTTP stream (so the server aborts Deepgram), stops the
   * scheduled audio and reports what the listener already heard.
   */
  stop(reason = 'manual'): StopResult {
    const t0 = this.now();
    this.turn += 1;
    this.stopPumpTimer();
    if (this.endWatchdog !== null) {
      clearTimeout(this.endWatchdog);
      this.endWatchdog = null;
    }
    const hadActive = Boolean(this.controller || this.audio || this.sources.length);
    const playedMs = this.playedMs();

    try {
      this.controller?.abort();
    } catch {
      /* already aborted */
    }
    try {
      void this.reader?.cancel().catch?.(() => undefined);
    } catch {
      /* reader already released */
    }
    this.reader = null;
    this.controller = null;

    for (const source of this.sources) {
      try {
        source.stop();
        source.disconnect?.();
      } catch {
        /* already ended */
      }
      source.onended = null;
    }
    this.sources = [];
    this.raw = new Uint8Array(0);
    this.decodedSeconds = 0;
    this.scheduledEnd = 0;
    this.startedAtCtx = null;
    this.smoothedLevel = 0;
    this.streamDone = false;

    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load?.();
      } catch {
        /* detached element */
      }
      this.audio.onended = null;
      this.audio = null;
    }
    if (this.objectUrl) {
      try {
        (this.deps.revokeObjectUrl || ((u: string) => URL.revokeObjectURL(u)))(this.objectUrl);
      } catch {
        /* ignore */
      }
      this.objectUrl = null;
    }

    this.ended = true;
    const waiters = this.endedResolvers;
    this.endedResolvers = [];
    for (const resolve of waiters) resolve();

    const teardownMs = Math.round(this.now() - t0);
    // A no-op stop must not pollute the trace used as barge-in evidence
    // (speak() calls stop() to supersede the previous turn).
    if (!hadActive) return { aborted: false, reason, playedMs: 0, teardownMs };
    this.emit('stop', { reason, playedMs: Math.round(playedMs), teardownMs });
    return { aborted: true, reason, playedMs: Math.round(playedMs), teardownMs };
  }

  get isActive(): boolean {
    if (this.ended) return false;
    return Boolean(this.audio) || Boolean(this.controller) || this.sources.length > 0;
  }
}

/** One shared player for the room. */
export const realtimeVoice = new RealtimeVoicePlayer();
