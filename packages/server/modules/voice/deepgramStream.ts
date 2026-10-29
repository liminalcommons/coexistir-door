/**
 * deepgramStream — the door's STREAMING ear.
 *
 * The batch ear (`deepgramStt`) waits for the visitor to stop talking, encodes
 * a WAV, and only THEN asks Deepgram. On the door that wait is the single
 * largest slice of "dead air": the owner's VAD closes an utterance after
 * 1200 ms of silence, the WAV costs ~10 ms, the HTTP round trip ~20 ms and the
 * provider call ~175 ms — so the words land ~1.4 s after the last syllable,
 * before `/turn` and TTS have even started.
 *
 * This module removes the wait instead of shrinking it. Audio is streamed to
 * Deepgram WHILE the visitor speaks, so the transcript is already computed when
 * they finish; what remains is only the provider's own endpointing window
 * (`endpointing`, default 500 ms) plus the tail of the socket. End of turn
 * comes from the PROVIDER's endpointing (`speech_final`) or, when the provider
 * stays silent, from `utterance_end_ms` — never from a fixed local timer.
 *
 * The key never leaves this process: the browser talks to our own WebSocket
 * route, which holds the Deepgram socket. See `coexistirVoiceStream.ts`.
 *
 * Everything here is pure or injectable (`clock`, `WebSocketImpl`), so the
 * query, the parser and the turn state machine are unit-tested without a
 * network, a microphone or a vendor.
 *
 * Measured on the rig (Portuguese question, 16 kHz linear16, endpointing=500):
 *   batch  /stt after 1200 ms local silence ....... ~1450-1700 ms to words
 *   stream endpointing (speech_final) ............ ~560-700 ms to words
 * (see scripts/door/stream-endpointing.mjs, which prints both on one clip.)
 */

/** Deepgram streaming model the door uses. */
export const DEFAULT_STREAM_MODEL = 'nova-3';

/** The rate the browser downsamples to before sending. */
export const STREAM_SAMPLE_RATE = 16000;

/** 16-bit mono PCM: bytes/millisecond, used to keep an audio clock. */
export const BYTES_PER_MS = (STREAM_SAMPLE_RATE * 2) / 1000;

/** Deepgram's public streaming endpoint. Overridable so a test can point at a stub. */
export const STREAM_ENDPOINT = 'wss://api.deepgram.com/v1/listen';

/**
 * What `auto` becomes on a streaming socket. `detect_language` is not available
 * there (the handshake 400s), so nova-3's `multi` mode is used instead: it
 * transcribes both languages the door speaks and tags each word with the one it
 * heard.
 */
export const STREAM_AUTO_LANGUAGE = 'multi';

export interface StreamConfig {
  model: string;
  sampleRate: number;
  /**
   * Silence (ms) after the last word that makes Deepgram emit `speech_final`.
   * THIS is the door's end-of-turn now. 500 ms is short enough to feel instant
   * and long enough that a breath mid-sentence does not usually split a turn;
   * when it does, the door's continuation merge (portalSttStream) rejoins it.
   */
  endpointing: number;
  /**
   * Hard close (ms of silence) for the `UtteranceEnd` event. Used as the
   * fallback turn trigger and as the cross-check on where speech really ended.
   */
  utteranceEndMs: number;
  interimResults: boolean;
  /** `SpeechStarted` events, so the page can show that it hears speech. */
  vadEvents: boolean;
  /** `auto` -> `detect_language=true`; a BCP-47 tag pins the language. */
  language: string;
  punctuate: boolean;
  /** Domain boosts, e.g. `Mara`. Deepgram wants `term` or `term:boost`. */
  keywords: string[];
}

export const STREAM_DEFAULTS: StreamConfig = {
  model: DEFAULT_STREAM_MODEL,
  sampleRate: STREAM_SAMPLE_RATE,
  endpointing: 500,
  utteranceEndMs: 1000,
  interimResults: true,
  vadEvents: true,
  language: 'auto',
  punctuate: true,
  keywords: [],
};

/**
 * The query string for a streaming socket. `encoding=linear16` + `sample_rate`
 * are not optional here: without them Deepgram assumes mulaw and every word
 * comes back garbled, which sounds like a broken microphone rather than a
 * configuration bug.
 */
export function buildStreamQuery(config: Partial<StreamConfig> = {}): string {
  const cfg: StreamConfig = { ...STREAM_DEFAULTS, ...config };
  const language = (cfg.language || 'auto').trim();
  const params = new URLSearchParams({
    model: cfg.model || DEFAULT_STREAM_MODEL,
    encoding: 'linear16',
    sample_rate: String(cfg.sampleRate || STREAM_SAMPLE_RATE),
    channels: '1',
    punctuate: cfg.punctuate ? 'true' : 'false',
    // The door never reads timings out of the payload, but `words[].end` is the
    // provider's own measure of where speech stopped — the honest base for
    // every stage timing below. It ships with the final result, so it costs no
    // extra round trip.
    smart_format: 'false',
    interim_results: cfg.interimResults ? 'true' : 'false',
    vad_events: cfg.vadEvents ? 'true' : 'false',
    // Endpointing must be explicit: Deepgram's default (10 ms) would cut a turn
    // at the first inter-word gap.
    endpointing: String(cfg.endpointing),
    // `utterance_end_ms` only has an effect when interim results are on.
    utterance_end_ms: String(cfg.utteranceEndMs),
  });
  if (language.toLowerCase() === 'auto' || !language) {
    // Streaming `/v1/listen` REJECTS `detect_language` (HTTP 400 on the
    // handshake — verified against the live API). nova-3's streaming answer is
    // `language=multi`: it transcribes PT/EN alike and tags every word with the
    // language it heard, which is a better signal than a per-utterance guess —
    // `parseStreamMessage` reads that tag as `detectedLanguage`.
    params.set('language', STREAM_AUTO_LANGUAGE);
  } else {
    params.set('language', language);
  }
  if (cfg.keywords && cfg.keywords.length > 0) {
    params.set('keywords', cfg.keywords.join(','));
  }
  return params.toString();
}

/** The wss URL for one streaming session (key is carried in the header, never here). */
export function buildStreamUrl(config: Partial<StreamConfig> = {}, endpoint = STREAM_ENDPOINT): string {
  return `${endpoint}?${buildStreamQuery(config)}`;
}

export interface StreamWord {
  start: number;
  end: number;
  word?: string;
  /** nova-3 `multi` mode tags each word with the language it heard. */
  language?: string;
}

export type StreamEvent =
  | { type: 'interim'; text: string; audioSec: number | null }
  | {
      type: 'final';
      text: string;
      /** Audio position (sec) this result's window ends at. */
      audioSec: number | null;
      /** Provider endpointing closed the utterance. */
      speechFinal: boolean;
      /** Provider-measured END of the last word (sec) — the end of speech. */
      wordsEndSec: number | null;
      detectedLanguage: string | null;
      languageConfidence: number | null;
      confidence: number | null;
    }
  | { type: 'speech_started'; audioSec: number | null }
  | { type: 'utterance_end'; audioSec: number | null; lastWordEndSec: number | null }
  | { type: 'metadata'; requestId: string | null; durationSec: number | null }
  | { type: 'error'; message: string; code: string | null }
  | { type: 'unknown'; rawType: string | null };

interface RawAlternative {
  transcript?: string;
  confidence?: number;
  words?: StreamWord[];
}

interface RawMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  timestamp?: number;
  last_word_end?: number;
  channel?: { alternatives?: RawAlternative[]; detected_language?: string; language_confidence?: number };
  metadata?: { request_id?: string; duration?: number };
  description?: string;
  message?: string;
  error_code?: string;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lastWordEnd(words: StreamWord[] | undefined): number | null {
  if (!Array.isArray(words) || words.length === 0) return null;
  let end: number | null = null;
  for (const word of words) {
    const value = num(word?.end);
    if (value !== null && (end === null || value > end)) end = value;
  }
  return end;
}

/**
 * The spoken language of a result. Streamed `multi` results carry no
 * `channel.detected_language`; the last word's `language` tag is the provider's
 * per-word verdict and is what the door should act on.
 */
function detectedLanguageOf(channel: RawMessage['channel'], words?: StreamWord[]): string | null {
  if (typeof channel?.detected_language === 'string' && channel.detected_language) {
    return channel.detected_language;
  }
  if (!Array.isArray(words)) return null;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const tag = words[i]?.language;
    if (typeof tag === 'string' && tag) return tag;
  }
  return null;
}

/**
 * Turn one Deepgram frame into a typed event. Unknown frames (KeepAlive,
 * Finalize, Close, provider additions) are reported as such instead of being
 * silently dropped: the route counts them, so "the vendor changed something" is
 * visible in the log rather than guessed at.
 */
export function parseStreamMessage(raw: unknown): StreamEvent {
  let message: RawMessage;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try {
      message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) as RawMessage;
    } catch {
      return { type: 'unknown', rawType: null };
    }
  } else if (raw && typeof raw === 'object') {
    message = raw as RawMessage;
  } else {
    return { type: 'unknown', rawType: null };
  }

  const type = typeof message.type === 'string' ? message.type : null;
  switch (type) {
    case 'Results': {
      const alternative = message.channel?.alternatives?.[0];
      const text = typeof alternative?.transcript === 'string' ? alternative.transcript.trim() : '';
      const start = num(message.start) ?? 0;
      const duration = num(message.duration) ?? 0;
      const audioSec = start + duration > 0 ? start + duration : null;
      if (message.is_final === true) {
        return {
          type: 'final',
          text,
          audioSec,
          speechFinal: message.speech_final === true,
          wordsEndSec: lastWordEnd(alternative?.words),
          detectedLanguage: detectedLanguageOf(message.channel, alternative?.words),
          languageConfidence: num(message.channel?.language_confidence),
          confidence: num(alternative?.confidence),
        };
      }
      return { type: 'interim', text, audioSec };
    }
    case 'SpeechStarted':
      return { type: 'speech_started', audioSec: num(message.timestamp) };
    case 'UtteranceEnd': {
      const last = num(message.last_word_end);
      return {
        type: 'utterance_end',
        audioSec: last,
        lastWordEndSec: last,
      };
    }
    case 'Metadata':
      return {
        type: 'metadata',
        requestId: typeof message.metadata?.request_id === 'string' ? message.metadata.request_id : null,
        durationSec: num(message.metadata?.duration),
      };
    case 'Error':
      return {
        type: 'error',
        message: message.description || message.message || 'provider error',
        code: typeof message.error_code === 'string' ? message.error_code : null,
      };
    default:
      return { type: 'unknown', rawType: type };
  }
}

export interface StreamTurn {
  /** Everything heard for this utterance, finals joined. */
  text: string;
  /** Which provider signal closed the turn. */
  by: 'speech_final' | 'utterance_end';
  /** Server clock at the closing frame. */
  atMs: number;
  /** Provider-measured end of the last word (sec, audio clock). */
  lastWordEndSec: number | null;
  /** Audio position where this utterance started, from `SpeechStarted`. */
  speechStartSec: number | null;
  /** Audio position at close, so the page can map it onto its own clock. */
  audioSec: number | null;
  detectedLanguage: string | null;
  languageConfidence: number | null;
  confidence: number | null;
  /** How many final results were joined into `text`. */
  finals: number;
  /** Wall time from the FIRST final of this utterance to the close. */
  finalsSpanMs: number;
}

/**
 * The turn state machine: a Deepgram stream in, turn boundaries out.
 *
 * Deepgram does not repeat the closing signal, and it can send both
 * (`speech_final` then `UtteranceEnd` ~500 ms later). A turn is emitted exactly
 * once per utterance; the second signal finds no pending text and is ignored.
 */
export class StreamSession {
  private text: string[] = [];
  private firstFinalAtMs: number | null = null;
  private speechStartSec: number | null = null;
  private lastWordEndSec: number | null = null;
  private lastAudioSec: number | null = null;
  private detected: string | null = null;
  private detectedConfidence: number | null = null;
  private confidence: number | null = null;
  private finalsInUtterance = 0;

  readonly stats = {
    frames: 0,
    finals: 0,
    interims: 0,
    speechStarts: 0,
    turns: 0,
    resets: 0,
    unknown: 0,
    errors: 0,
    lastTurnAtMs: 0,
  };

  constructor(private readonly clock: () => number = Date.now) {}

  /** `true` when there is text a `speech_final`/`utterance_end` could close. */
  get hasPending(): boolean {
    return this.text.length > 0;
  }

  /** Text heard so far in the CURRENT utterance (interim or final). */
  get pendingText(): string {
    return this.text.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Mic off / barge-in reset: the half-heard words are dropped and no turn can
   * be produced from them. This is what makes "OFF is deaf" true on the stream
   * path too, not just on the local one.
   */
  reset(): void {
    if (this.text.length > 0 || this.finalsInUtterance > 0) this.stats.resets += 1;
    this.text = [];
    this.firstFinalAtMs = null;
    this.speechStartSec = null;
    this.lastWordEndSec = null;
    this.detected = null;
    this.detectedConfidence = null;
    this.confidence = null;
    this.finalsInUtterance = 0;
  }

  /** Feed one parsed frame. Returns a turn only when the provider closed one. */
  handle(event: StreamEvent): StreamTurn | null {
    this.stats.frames += 1;
    switch (event.type) {
      case 'interim':
        this.stats.interims += 1;
        if (event.audioSec !== null) this.lastAudioSec = event.audioSec;
        return null;

      case 'speech_started':
        this.stats.speechStarts += 1;
        // A new utterance began: whatever was pending belongs to the past.
        if (this.finalsInUtterance > 0) this.reset();
        this.speechStartSec = event.audioSec;
        if (event.audioSec !== null) this.lastAudioSec = event.audioSec;
        return null;

      case 'final': {
        this.stats.finals += 1;
        if (event.audioSec !== null) this.lastAudioSec = event.audioSec;
        if (event.detectedLanguage) {
          this.detected = event.detectedLanguage;
          this.detectedConfidence = event.languageConfidence;
        }
        if (event.confidence !== null) this.confidence = event.confidence;
        if (event.wordsEndSec !== null) this.lastWordEndSec = event.wordsEndSec;
        if (event.text) {
          this.text.push(event.text);
          this.finalsInUtterance += 1;
          if (this.firstFinalAtMs === null) this.firstFinalAtMs = this.clock();
        }
        if (!event.speechFinal) return null;
        return this.close('speech_final');
      }

      case 'utterance_end':
        if (event.lastWordEndSec !== null && this.lastWordEndSec === null) {
          this.lastWordEndSec = event.lastWordEndSec;
        }
        // Already closed by `speech_final`, or nothing was said: no turn.
        if (!this.hasPending) return null;
        return this.close('utterance_end');

      case 'error':
        this.stats.errors += 1;
        return null;

      case 'metadata':
        return null;

      default:
        this.stats.unknown += 1;
        return null;
    }
  }

  private close(by: 'speech_final' | 'utterance_end'): StreamTurn | null {
    const text = this.pendingText;
    if (!text) {
      this.reset();
      return null;
    }
    const atMs = this.clock();
    const turn: StreamTurn = {
      text,
      by,
      atMs,
      lastWordEndSec: this.lastWordEndSec,
      speechStartSec: this.speechStartSec,
      audioSec: this.lastAudioSec,
      detectedLanguage: this.detected,
      languageConfidence: this.detectedConfidence,
      confidence: this.confidence,
      finals: this.finalsInUtterance,
      finalsSpanMs: this.firstFinalAtMs === null ? 0 : Math.round(atMs - this.firstFinalAtMs),
    };
    this.stats.turns += 1;
    this.stats.lastTurnAtMs = atMs;
    this.reset();
    return turn;
  }
}

// --- transport -------------------------------------------------------------

/** The slice of `ws` this module needs. Node's global WebSocket is close but
 *  cannot carry an Authorization header, so the default is `ws`. */
export interface WsLike {
  on(event: 'open' | 'close' | 'error' | 'message', listener: (...args: unknown[]) => void): void;
  send(data: string | Uint8Array, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
}

export type WsFactory = (url: string, options: { headers: Record<string, string> }) => WsLike;

export interface StreamTransportOptions {
  apiKey?: string;
  config?: Partial<StreamConfig>;
  /** Parsed provider frames, in order. */
  onEvent: (event: StreamEvent) => void;
  onOpen?: () => void;
  onClose?: (code: number | null, reason: string | null) => void;
  onError?: (message: string) => void;
  WebSocketImpl?: WsFactory;
  endpoint?: string;
}

export interface StreamTransport {
  /** Push 16-bit mono PCM at `config.sampleRate`. Returns bytes accepted. */
  send(audio: Uint8Array): number;
  /** Ask the provider to finalize what it has (end of a known utterance). */
  finalize(): void;
  /** Empty keep-alive, so a quiet room does not lose the socket to a 10 s idle timeout. */
  keepAlive(): void;
  close(code?: number, reason?: string): void;
  readonly bytesIn: number;
  readonly opened: boolean;
  readonly closed: boolean;
  readonly audioMs: number;
}

function readKey(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  return process.env.DEEPGRAM_API_KEY || '';
}

/**
 * Open the streaming socket upstream. The key is put in the `Authorization`
 * header on THIS side only; nothing returned here exposes it.
 *
 * Failure is reported through `onError` and never thrown: a door with no key
 * must still run, it just falls back to the batch ear.
 */
export function openDeepgramStream(options: StreamTransportOptions): StreamTransport {
  const key = readKey(options.apiKey);
  const url = buildStreamUrl(options.config, options.endpoint);
  let socket: WsLike | null = null;
  let opened = false;
  let closed = false;
  let bytesIn = 0;

  const transport: StreamTransport = {
    get bytesIn() {
      return bytesIn;
    },
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    get audioMs() {
      return Math.round(bytesIn / BYTES_PER_MS);
    },
    send(audio: Uint8Array) {
      if (!socket || closed || audio.byteLength === 0) return 0;
      try {
        socket.send(audio, { binary: true });
        bytesIn += audio.byteLength;
        return audio.byteLength;
      } catch (err) {
        options.onError?.(err instanceof Error ? err.message : String(err));
        return 0;
      }
    },
    finalize() {
      if (!socket || closed) return;
      try {
        socket.send(JSON.stringify({ type: 'Finalize' }));
      } catch {
        /* socket already gone */
      }
    },
    keepAlive() {
      if (!socket || closed) return;
      try {
        socket.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch {
        /* socket already gone */
      }
    },
    close(code = 1000, reason = 'door closed') {
      if (closed) return;
      closed = true;
      try {
        socket?.close(code, reason);
      } catch {
        /* already gone */
      }
    },
  };

  if (!key) {
    closed = true;
    options.onError?.('no_key');
    return transport;
  }

  const factory: WsFactory =
    options.WebSocketImpl ??
    ((target, init) => {
      // Lazy require: the module stays importable in environments (browser
      // bundles, type-only tests) where `ws` is not installed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Ws = require('ws') as new (url: string, options: unknown) => WsLike;
      return new Ws(target, init);
    });

  try {
    socket = factory(url, { headers: { Authorization: `Token ${key}` } });
  } catch (err) {
    closed = true;
    options.onError?.(err instanceof Error ? err.message : String(err));
    return transport;
  }

  socket.on('open', () => {
    opened = true;
    options.onOpen?.();
  });
  socket.on('message', (data: unknown) => {
    options.onEvent(parseStreamMessage(data));
  });
  socket.on('error', (err: unknown) => {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'stream socket error';
    // A socket error is always followed by a close; report it once, here.
    options.onError?.(message);
  });
  socket.on('close', (...args: unknown[]) => {
    closed = true;
    const code = typeof args[0] === 'number' ? args[0] : null;
    const reason = typeof args[1] === 'string' ? args[1] : Buffer.isBuffer(args[1]) ? args[1].toString('utf8') : null;
    options.onClose?.(code, reason);
  });

  return transport;
}
