/**
 * portalSttStream — the page half of the door's streaming ear.
 *
 * The batch path (`transcribeUtterance` on a WAV) can only start AFTER the
 * visitor stops talking: the VAD waits out 1200 ms of silence, the clip is
 * encoded, and only then does the words come back. Measured end to end on the
 * rig with the door's own voice (Portuguese, 3 s question, see
 * `packages/server/scripts/proofSttStream.ts`):
 *
 *   batch   last sample of speech -> words ....... ~1700 ms
 *   stream  last sample of speech -> words .......  ~630 ms  (500 ms endpointing + relay)
 *
 * This module is the page half of that second number. While MIC is on, every
 * block the worklet captures is converted to 16-bit PCM and pushed to the
 * server's WebSocket relay, which holds the Deepgram socket. End of turn arrives
 * from the provider's own endpointing.
 *
 * Two things here are easy to get wrong, so they are explicit:
 *
 * 1. RESAMPLING. The AudioContext runs at 48 kHz and Deepgram wants 16 kHz, so
 *    every output sample is the mean of the input samples it covers — the same
 *    averaging `encodeWav` uses. A block boundary must not shift that grid, so
 *    the leftover samples are carried into the next block (`Pcm16Downsampler`).
 *    Dropping them makes the recording drift a few ms per second and quietly
 *    mangles word timing.
 *
 * 2. THE AUDIO CLOCK. Deepgram reports positions in SECONDS OF AUDIO
 *    (`last_word_end`, `words[].end`), not wall time. To say "the words came
 *    back 620 ms after the visitor stopped talking", those positions have to be
 *    mapped onto `performance.now()`. `AudioClock` keeps the pairs (audioMs,
 *    perfMs) as audio is handed to the socket and interpolates, so the mapping
 *    stays honest even when blocks queue up during a main-thread stall.
 *
 * The key is not here and cannot be: the socket is same-origin, and the server
 * is the only side that talks to Deepgram (review #7).
 */

/** Where the relay lives. Same origin: this page is served by that server. */
export const STT_STREAM_PATH = '/api/coexistir/voice/stt-stream';

/** Deepgram's `speech_final`/`UtteranceEnd` positions, as the relay sends them. */
export interface SttStreamTurn {
  t: 'turn';
  turnId: string;
  text: string;
  by: 'speech_final' | 'utterance_end';
  language: string;
  detectedLanguage: string | null;
  confidence: number | null;
  /** Provider endpointing + relay, from the last word (audio clock). */
  sttMs: number;
  audio: {
    speechStartMs: number | null;
    lastWordEndMs: number | null;
    atMs: number | null;
  };
  finals: number;
  finalsSpanMs: number;
}

/** A turn as the page sees it: audio positions already mapped to `now()` time. */
export interface SttStreamTurnEvent extends SttStreamTurn {
  /** When this frame reached the page. */
  atPerf: number;
  /** The provider's last voiced frame, on the page's clock. The timing base. */
  lastWordEndPerf: number | null;
  /** Where this utterance began, on the page's clock (for the merge window). */
  speechStartPerf: number | null;
}

export interface SttStreamSnapshot {
  ready: boolean;
  closed: boolean;
  mode: 'stream' | 'off';
  audioMs: number;
  blocks: number;
  bytes: number;
  turns: number;
  interims: number;
  /** Blocks that reached `send()` before the relay was ready — audio never sent. */
  unsentBlocks: number;
  /** Last measured: provider endpointing + relay, from the last word. */
  lastSttMs: number | null;
  /** Audio queued between capture and the socket, if the page stalled. */
  maxSendLagMs: number;
  endpointing: number | null;
  utteranceEndMs: number | null;
}

export interface PortalSttStreamOptions {
  /** Defaults to the same-origin relay path. */
  url?: string;
  room?: string;
  language?: string;
  /**
   * Rate of the blocks handed to `send()`. Defaults to 48 kHz, which is what
   * Chrome's AudioContext runs at; a 44.1 kHz kiosk passes its own rate (or, as
   * the door does, the rate from the VAD's snapshot) so the resampling grid is
   * right instead of 8% fast.
   */
  inputRate?: number;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  /** Milliseconds to wait for the relay's `ready` before giving up. */
  connectTimeoutMs?: number;
  onReady?: (info: { endpointing: number; utteranceEndMs: number; model: string }) => void;
  onInterim?: (text: string) => void;
  onFinal?: (event: { text: string; speechFinal: boolean; audioMs: number | null }) => void;
  onTurn?: (turn: SttStreamTurnEvent) => void;
  onError?: (code: string, message: string) => void;
  onClose?: (reason: string) => void;
  onWarn?: (message: string) => void;
}

export interface PortalSttStreamHandle {
  /** Resolves true when the relay is ready to accept audio. */
  connect: () => Promise<boolean>;
  /** Push captured Float32 blocks at `inputRate`. Never throws. */
  send: (samples: Float32Array, atPerf?: number, inputRate?: number) => void;
  /** Mic off / barge-in: drop the partial utterance on the server too. */
  reset: () => void;
  /** Ask the provider to close what it has (end of a known utterance). */
  finalize: () => void;
  close: () => void;
  snapshot: () => SttStreamSnapshot;
  readonly ready: boolean;
  readonly audioMs: number;
}

/** The wss URL for the relay, built from the page's own origin (never a key). */
export function sttStreamUrl(
  options: { url?: string; room?: string; language?: string } = {},
  location?: { protocol?: string; host?: string },
): string {
  if (options.url) {
    const base = options.url;
    const query = new URLSearchParams();
    if (options.room) query.set('room', options.room);
    if (options.language) query.set('language', options.language);
    return query.toString() ? `${base}${base.includes('?') ? '&' : '?'}${query.toString()}` : base;
  }
  // The origin must come from the PAGE, not only from an injected one: over the
  // public HTTPS door, `location?.protocol` was undefined and this built
  // `ws://door.castalia.one/...`, which the browser refuses as mixed content —
  // the stream never opened and every public turn silently fell back to batch.
  const pageLocation =
    location ?? (typeof window !== 'undefined' ? window.location : undefined);
  const proto = pageLocation?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = pageLocation?.host ?? 'localhost';
  const query = new URLSearchParams();
  if (options.room) query.set('room', options.room);
  if (options.language) query.set('language', options.language);
  return `${proto}//${host}${STT_STREAM_PATH}${query.toString() ? `?${query.toString()}` : ''}`;
}

/**
 * Float32 (any rate) -> Int16 mono PCM at 16 kHz, with a carried remainder.
 *
 * The averaging is the same box filter as `encodeWav`, so a clip transcribed by
 * the batch path and the same audio streamed here produce the same waveform —
 * otherwise a language detection could flip between the two paths and look like
 * a provider bug.
 */
export class Pcm16Downsampler {
  private carry: Float32Array = new Float32Array(0);

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {}

  /** Samples pushed but not yet emitted (the resampling grid's remainder). */
  get pending(): number {
    return this.carry.length;
  }

  push(samples: Float32Array): Int16Array {
    if (samples.length === 0) return new Int16Array(0);
    const ratio = this.inRate / this.outRate;
    const input =
      this.carry.length === 0
        ? samples
        : (() => {
            const merged = new Float32Array(this.carry.length + samples.length);
            merged.set(this.carry, 0);
            merged.set(samples, this.carry.length);
            return merged;
          })();

    const outLength = Math.floor(input.length / ratio);
    if (outLength === 0) {
      this.carry = new Float32Array(input);
      return new Int16Array(0);
    }
    const pcm = new Int16Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    const consumed = Math.floor(outLength * ratio);
    this.carry = new Float32Array(input.length - consumed);
    this.carry.set(input.subarray(consumed));
    return pcm;
  }

  reset(): void {
    this.carry = new Float32Array(0);
  }
}

/**
 * Audio position -> page clock. Positions are recorded as audio is handed to
 * the socket; a lookup interpolates inside the recorded window and extrapolates
 * (at 1:1, which is what real-time capture means) beyond its end.
 */
export class AudioClock {
  private readonly audio: number[] = [];
  private readonly perf: number[] = [];
  private readonly keep = 512;

  push(audioMs: number, perfMs: number): void {
    this.audio.push(audioMs);
    this.perf.push(perfMs);
    if (this.audio.length > this.keep) {
      this.audio.splice(0, this.audio.length - this.keep);
      this.perf.splice(0, this.perf.length - this.keep);
    }
  }

  /** Page-clock time of an audio position, or null when nothing was sent. */
  toPerf(audioMs: number | null): number | null {
    if (audioMs === null || !Number.isFinite(audioMs)) return null;
    if (this.audio.length === 0) return null;
    // First record at or after the position: the block that covered it.
    for (let i = 0; i < this.audio.length; i += 1) {
      if (this.audio[i] >= audioMs) {
        const behind = this.audio[i] - audioMs;
        return this.perf[i] - behind;
      }
    }
    const last = this.audio.length - 1;
    // Beyond what was sent: real-time capture, so the audio clock and the page
    // clock advance together.
    return this.perf[last] + (audioMs - this.audio[last]);
  }

  get lastAudioMs(): number {
    return this.audio.length === 0 ? 0 : this.audio[this.audio.length - 1];
  }

  clear(): void {
    this.audio.length = 0;
    this.perf.length = 0;
  }
}

/**
 * One streaming ear. `connect()` is idempotent and safe to call before MIC is
 * on: a door that cannot stream must keep working, so every failure path here
 * reports through `onError` and leaves the batch path untouched.
 */
export function createPortalSttStream(options: PortalSttStreamOptions = {}): PortalSttStreamHandle {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const sampleRate = 16000;
  let socket: WebSocket | null = null;
  let downsampler: Pcm16Downsampler | null = null;
  let ready = false;
  let closed = false;
  let pendingConnect: Promise<boolean> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  const clock = new AudioClock();
  const state = {
    blocks: 0,
    bytes: 0,
    turns: 0,
    interims: 0,
    lastSttMs: null as number | null,
    maxSendLagMs: 0,
    endpointing: null as number | null,
    utteranceEndMs: null as number | null,
    /**
     * Blocks the ear captured while the relay was NOT ready, so they were never
     * sent. This is the number that separates "the visitor said nothing" from
     * "the visitor spoke into a socket that was not there" — the live door had
     * no such number, so a dead relay and a silent room read identically.
     */
    unsentBlocks: 0,
  };

  const audioMsNow = () => (state.bytes / 32) | 0;
  /** Samples per millisecond at the rate we send (16 kHz -> 16 samples/ms). */
  const samplesPerMs = sampleRate / 1000;

  const clearTimer = () => {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
  };

  const handleMessage = (raw: unknown) => {
    let message: Record<string, unknown> | null = null;
    if (typeof raw === 'string') {
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
    }
    if (!message) return;
    const type = typeof message.t === 'string' ? message.t : '';
    switch (type) {
      case 'ready': {
        ready = true;
        state.endpointing = typeof message.endpointing === 'number' ? message.endpointing : null;
        state.utteranceEndMs = typeof message.utteranceEndMs === 'number' ? message.utteranceEndMs : null;
        clearTimer();
        options.onReady?.({
          endpointing: state.endpointing ?? 0,
          utteranceEndMs: state.utteranceEndMs ?? 0,
          model: typeof message.model === 'string' ? message.model : '',
        });
        return;
      }
      case 'interim': {
        state.interims += 1;
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (text) options.onInterim?.(text);
        return;
      }
      case 'final': {
        options.onFinal?.({
          text: typeof message.text === 'string' ? message.text : '',
          speechFinal: message.speechFinal === true,
          audioMs: typeof message.audioMs === 'number' ? message.audioMs : null,
        });
        return;
      }
      case 'turn': {
        state.turns += 1;
        const audio = (message.audio ?? {}) as Record<string, unknown>;
        const lastWordEndMs = typeof audio.lastWordEndMs === 'number' ? audio.lastWordEndMs : null;
        const speechStartMs = typeof audio.speechStartMs === 'number' ? audio.speechStartMs : null;
        const atPerf = now();
        const turn: SttStreamTurnEvent = {
          t: 'turn',
          turnId: typeof message.turnId === 'string' ? message.turnId : '',
          text: typeof message.text === 'string' ? message.text : '',
          by: message.by === 'utterance_end' ? 'utterance_end' : 'speech_final',
          language: typeof message.language === 'string' ? message.language : 'pt',
          detectedLanguage:
            typeof message.detectedLanguage === 'string' ? message.detectedLanguage : null,
          confidence: typeof message.confidence === 'number' ? message.confidence : null,
          sttMs: typeof message.sttMs === 'number' ? message.sttMs : 0,
          audio: {
            speechStartMs,
            lastWordEndMs,
            atMs: typeof audio.atMs === 'number' ? audio.atMs : null,
          },
          finals: typeof message.finals === 'number' ? message.finals : 0,
          finalsSpanMs: typeof message.finalsSpanMs === 'number' ? message.finalsSpanMs : 0,
          atPerf,
          lastWordEndPerf: clock.toPerf(lastWordEndMs),
          speechStartPerf: clock.toPerf(speechStartMs),
        };
        state.lastSttMs = turn.sttMs;
        options.onTurn?.(turn);
        return;
      }
      case 'error': {
        options.onError?.(
          typeof message.code === 'string' ? message.code : 'stream',
          typeof message.message === 'string' ? message.message : 'stream error',
        );
        return;
      }
      case 'closed': {
        const reason = typeof message.reason === 'string' ? message.reason : 'closed';
        if (ready) options.onClose?.(reason);
        closed = true;
        ready = false;
        return;
      }
      default:
        return;
    }
  };

  const handle: PortalSttStreamHandle = {
    get ready() {
      return ready;
    },
    get audioMs() {
      return audioMsNow();
    },
    connect() {
      if (ready) return Promise.resolve(true);
      if (pendingConnect) return pendingConnect;
      const Impl =
        options.WebSocketImpl ??
        (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
      if (!Impl) {
        options.onError?.('no_websocket', 'this browser has no WebSocket');
        return Promise.resolve(false);
      }
      /**
       * Open one socket and wait for the relay's `ready`. On timeout the socket
       * is CLOSED: a socket abandoned mid-handshake still opens a moment later,
       * and then the page holds a relay that is ready, that nobody sends audio
       * to (the caller has already fallen back), and that no `onClose` ever
       * reports — the door looks connected and is deaf. Measured live: a cold
       * handshake through the tunnel can lose a 2 s race.
       */
      const attempt = (timeoutMs: number): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          let settled = false;
          const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimer();
            resolve(ok);
          };
          const abandon = () => {
            closed = true;
            ready = false;
            try {
              socket?.close(1000, 'connect timeout');
            } catch {
              /* already gone */
            }
            socket = null;
          };
          const url = sttStreamUrl({
            url: options.url,
            room: options.room ?? 'coexistir',
            language: options.language ?? 'auto',
          });
          try {
            socket = new Impl(url);
            socket.binaryType = 'arraybuffer';
          } catch (err) {
            options.onError?.('connect', err instanceof Error ? err.message : String(err));
            settle(false);
            return;
          }
          connectTimer = setTimeout(() => {
            options.onError?.('timeout', `stream relay not ready in ${timeoutMs} ms`);
            abandon();
            settle(false);
          }, timeoutMs);

          socket.onopen = () => {
            downsampler = new Pcm16Downsampler(48000, sampleRate);
          };
          socket.onmessage = (event: MessageEvent) => {
            if (closed) return;
            handleMessage(event.data);
            if (ready) settle(true);
          };
          socket.onerror = () => {
            options.onError?.('socket', 'stream socket error');
            settle(false);
          };
          socket.onclose = (event: CloseEvent) => {
            const wasReady = ready;
            ready = false;
            if (!settled) {
              options.onError?.('closed', `stream closed before ready (${event.code})`);
              settle(false);
              return;
            }
            if (wasReady) options.onClose?.(event.reason || 'closed');
          };
        });

      pendingConnect = (async () => {
        // Two attempts: the second is for a truly slow handshake (a cold TLS +
        // Deepgram open through the tunnel), not for a dead relay — a refusal
        // fails fast and does not pay the full timeout twice.
        const first = await attempt(options.connectTimeoutMs ?? 4000);
        if (first) return true;
        closed = false;
        const second = await attempt(options.connectTimeoutMs ?? 4000);
        return second;
      })().finally(() => {
        pendingConnect = null;
      });
      return pendingConnect;
    },
    send(samples: Float32Array, atPerf?: number, inputRate?: number) {
      if (!socket || !ready || closed || samples.length === 0) {
        // Counted, not silently dropped: `unsentBlocks` is the only evidence
        // that the ear captured audio while the relay was not there.
        if (samples.length > 0) state.unsentBlocks += 1;
        return;
      }
      // The AudioContext may run at 44.1 or 48 kHz; the downsampler is created
      // against whatever the first block says, then kept — unless the rate
      // actually changes mid-session (a device switch), in which case rebuilding
      // is the only correct answer.
      const rate = inputRate && inputRate > 0 ? inputRate : (options.inputRate ?? 48000);
      if (!downsampler || downsampler.inRate !== rate) downsampler = new Pcm16Downsampler(rate, sampleRate);
      const pcm = downsampler.push(samples);
      if (pcm.length === 0) return;
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const at = now();
      // Capture -> socket queueing: the page's own stall shows up here instead
      // of as lost audio (the worklet has already stamped the block).
      if (typeof atPerf === 'number' && Number.isFinite(atPerf)) {
        state.maxSendLagMs = Math.max(state.maxSendLagMs, Math.round(at - atPerf));
      }
      try {
        // A COPY: the socket may keep the buffer after send returns.
        socket.send(bytes.slice().buffer);
      } catch (err) {
        options.onWarn?.(`stream send failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      clock.push(audioMsNow() + pcm.length / samplesPerMs, at);
      state.blocks += 1;
      state.bytes += pcm.byteLength;
    },
    reset() {
      downsampler?.reset();
      if (socket && ready) {
        try {
          socket.send(JSON.stringify({ t: 'reset' }));
        } catch {
          /* socket gone */
        }
      }
    },
    finalize() {
      if (socket && ready) {
        try {
          socket.send(JSON.stringify({ t: 'finalize' }));
        } catch {
          /* socket gone */
        }
      }
    },
    close() {
      closed = true;
      ready = false;
      clearTimer();
      downsampler?.reset();
      try {
        socket?.close(1000, 'mic off');
      } catch {
        /* already gone */
      }
      socket = null;
      clock.clear();
    },
    snapshot(): SttStreamSnapshot {
      return {
        ready,
        closed,
        mode: ready ? 'stream' : 'off',
        audioMs: audioMsNow(),
        blocks: state.blocks,
        bytes: state.bytes,
        turns: state.turns,
        interims: state.interims,
        unsentBlocks: state.unsentBlocks,
        lastSttMs: state.lastSttMs,
        maxSendLagMs: state.maxSendLagMs,
        endpointing: state.endpointing,
        utteranceEndMs: state.utteranceEndMs,
      };
    },
  };

  return handle;
}
