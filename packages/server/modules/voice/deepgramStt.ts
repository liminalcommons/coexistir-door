/**
 * deepgramStt — one pre-recorded transcription for the front-door mic.
 *
 * The portal has no text box any more: the only way a visitor asks Mara
 * anything is by talking. This module is the server half of that — it takes the
 * recorder's bytes (webm/opus from Chrome's MediaRecorder, but any container
 * Deepgram accepts works) and returns the words plus the spoken language.
 *
 * Why pre-recorded (batch) and not streaming: push-to-talk ships one complete
 * clip when the visitor stops talking, so `/v1/listen` on that clip is the
 * shortest correct path. Measured warm against the real API on the rig's own
 * fixtures (2.3–3.3 s opus clips) the provider call costs 110–320 ms, median
 * ~175 ms; `smart_format` alone measured +60 ms at the median and the talker
 * reads plain text, so it is off and `punctuate` stays on.
 *
 * NOTE (streaming slice): the door no longer waits for the clip. When MIC is on
 * the page streams PCM through `deepgramStream` (WebSocket relay, provider
 * endpointing) and this module is the FALLBACK — a socket that cannot open, or a
 * deployment with no key, still answers here. The 1200 ms local silence wait is
 * what streaming removes; that is why this path is kept rather than deleted:
 * it is the honest floor when the stream is unavailable.
 *
 * Contracts that matter to the caller:
 * - the API key is read from the environment on the server and never leaves it;
 * - `language: 'auto'` asks Deepgram to detect the spoken language, so an
 *   English visitor at a Portuguese kiosk still gets an English answer;
 * - every failure is a typed result (`ok: false` + `reason`), never a throw and
 *   never a fabricated transcript;
 * - `sttMs` is the whole server-side wait (prep + provider + parse), because
 *   that is the number the portal's TTFA budget has to pay for.
 *
 * `fetch`, the clock and the key are injectable so the route's tests run
 * without network or wall-clock flakiness.
 */

export const DEFAULT_STT_MODEL = 'nova-3';

/** Deepgram detected languages the manager can actually answer in. */
export type SttTurnLanguage = 'pt' | 'en';

export type SttFailure =
  | 'empty_audio'
  | 'no_key'
  | 'http'
  | 'timeout'
  | 'bad_response'
  | 'error';

export interface TranscribeRequest {
  audio: Buffer | Uint8Array;
  /** The recorder's container, e.g. `audio/webm` (codecs stripped by the route). */
  mimetype?: string;
  /** `auto` (default) detects the spoken language; a BCP-47 tag pins it. */
  language?: string;
  model?: string;
  /** Domain boosts, e.g. `Mara`. Deepgram wants `term` or `term:boost`. */
  keywords?: string[];
  /** Provider timeout; a door must never hang on a stalled vendor. */
  timeoutMs?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Caller abort (client hung up). */
  signal?: AbortSignal;
}

export interface TranscribeResult {
  ok: boolean;
  provider: 'deepgram';
  model: string;
  text: string;
  /** Language the manager should answer in, when it is one we support. */
  language: SttTurnLanguage | null;
  /** Raw provider detection, e.g. `pt` / `en`. */
  detectedLanguage: string | null;
  languageConfidence: number | null;
  /** Per-transcript confidence (0..1). */
  confidence: number | null;
  /** Duration of the uploaded audio, per the provider. */
  durationSec: number | null;
  bytes: number;
  mimetype: string;
  /** Server-side wall clock: handler entry -> transcript in hand. */
  sttMs: number;
  /** Just the provider round trip. */
  providerMs: number;
  status?: number;
  reason?: SttFailure;
  detail?: string;
}

export interface ListenResponseShape {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      language_confidence?: number;
      alternatives?: Array<{ transcript?: string; confidence?: number }>;
    }>;
  };
}

/**
 * Map a provider language tag onto the manager's two answer languages.
 * Anything else is `null` so the caller keeps the door's own language instead
 * of guessing at a language the voice matrix cannot speak.
 */
export function toTurnLanguage(tag: string | null | undefined): SttTurnLanguage | null {
  const value = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!value) return null;
  if (value.startsWith('pt')) return 'pt';
  if (value.startsWith('en')) return 'en';
  return null;
}

/** The `/v1/listen` query string for one request. */
export function buildListenQuery(options: { model?: string; language?: string; keywords?: string[] } = {}): string {
  const model = options.model || DEFAULT_STT_MODEL;
  const language = (options.language || 'auto').trim();
  const params = new URLSearchParams({
    model,
    punctuate: 'true',
    // The portal never needs timings or summaries; leave them off (bytes + ms).
    utterances: 'false',
    filler_words: 'false',
  });
  if (language.toLowerCase() === 'auto' || !language) {
    params.set('detect_language', 'true');
  } else {
    params.set('language', language);
  }
  if (options.keywords && options.keywords.length > 0) {
    params.set('keywords', options.keywords.join(','));
  }
  return params.toString();
}

/** Pull the transcript + language out of a `/v1/listen` body. */
export function parseListenResponse(json: ListenResponseShape | null): {
  text: string;
  detectedLanguage: string | null;
  languageConfidence: number | null;
  confidence: number | null;
  durationSec: number | null;
} {
  const channel = json?.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const text = typeof alternative?.transcript === 'string' ? alternative.transcript.trim() : '';
  const detected = typeof channel?.detected_language === 'string' ? channel.detected_language : null;
  return {
    text,
    detectedLanguage: detected,
    languageConfidence:
      typeof channel?.language_confidence === 'number' ? channel.language_confidence : null,
    confidence: typeof alternative?.confidence === 'number' ? alternative.confidence : null,
    durationSec: typeof json?.metadata?.duration === 'number' ? json.metadata.duration : null,
  };
}

function readApiKey(request: TranscribeRequest): string {
  // An explicit (even empty) key wins: `''` must mean "no key configured"
  // rather than silently falling back to whatever the shell exported.
  return request.apiKey !== undefined ? request.apiKey : process.env.DEEPGRAM_API_KEY || '';
}

/**
 * Build a tiny PCM WAV of silence. Used only to warm the provider connection:
 * no vendor SDK is needed to emit 48 bytes of RIFF header plus zeros.
 */
export function silentWav(ms = 160, sampleRate = 16000): Buffer {
  const samples = Math.max(1, Math.round((sampleRate * ms) / 1000));
  const dataBytes = samples * 2; // mono, 16-bit
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

/**
 * Pay the connection cost once, at boot, instead of on the first visitor.
 *
 * Measured on the rig: the first `/stt` call after a restart took 643 ms while
 * an identical clip 30 s later took 184 ms — the difference is DNS + TLS + HTTP/2
 * setup, not transcription. A 160 ms silent clip through the same endpoint pays
 * that while the door is idle. Failure is irrelevant: a warm-up that cannot run
 * just means the first visitor pays it, so this never throws.
 */
export async function warmStt(
  options: { model?: string; apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  try {
    const result = await transcribeAudio({
      audio: silentWav(),
      mimetype: 'audio/wav',
      language: 'pt-BR',
      model: options.model,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: 5000,
    });
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Transcribe one clip. Resolves a typed result for every outcome: an empty
 * upload, a missing key, a provider 4xx, a stall, a malformed body.
 */
export async function transcribeAudio(request: TranscribeRequest): Promise<TranscribeResult> {
  const now = request.now ?? Date.now;
  const startedAt = now();
  const model = request.model || DEFAULT_STT_MODEL;
  const mimetype = (request.mimetype || 'audio/webm').split(';')[0].trim();
  const bytes = request.audio?.byteLength ?? 0;
  const empty: TranscribeResult = {
    ok: false,
    provider: 'deepgram',
    model,
    text: '',
    language: null,
    detectedLanguage: null,
    languageConfidence: null,
    confidence: null,
    durationSec: null,
    bytes,
    mimetype,
    sttMs: 0,
    providerMs: 0,
  };

  if (bytes === 0) return { ...empty, reason: 'empty_audio', sttMs: now() - startedAt };

  const apiKey = readApiKey(request);
  if (!apiKey) return { ...empty, reason: 'no_key', sttMs: now() - startedAt };

  const fetchImpl = request.fetchImpl || fetch;
  const query = buildListenQuery({
    model,
    language: request.language,
    keywords: request.keywords,
  });
  const url = `https://api.deepgram.com/v1/listen?${query}`;

  // Two abort sources: the door's timeout and the caller's own signal.
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? 9000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const providerStartedAt = now();
  let status = 0;
  let bodyText = '';
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': mimetype,
        Accept: 'application/json',
      },
      body: request.audio as unknown as BodyInit,
      signal: controller.signal,
    });
    status = response.status;
    bodyText = await response.text();
  } catch (err) {
    const aborted = controller.signal.aborted;
    const timedOut = aborted && !request.signal?.aborted;
    return {
      ...empty,
      status: status || undefined,
      reason: timedOut ? 'timeout' : 'error',
      detail: err instanceof Error ? err.message : String(err),
      providerMs: now() - providerStartedAt,
      sttMs: now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }

  const providerMs = now() - providerStartedAt;

  let parsed: ListenResponseShape | null = null;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as ListenResponseShape) : null;
  } catch {
    parsed = null;
  }

  if (status < 200 || status >= 300) {
    const detail =
      (parsed as unknown as { err_msg?: string; error?: string } | null)?.err_msg ||
      (parsed as unknown as { error?: string } | null)?.error ||
      bodyText.slice(0, 200) ||
      `HTTP ${status}`;
    return {
      ...empty,
      status,
      reason: 'http',
      detail,
      providerMs,
      sttMs: now() - startedAt,
    };
  }

  if (!parsed) {
    return {
      ...empty,
      status,
      reason: 'bad_response',
      detail: bodyText.slice(0, 200),
      providerMs,
      sttMs: now() - startedAt,
    };
  }

  const result = parseListenResponse(parsed);
  return {
    ok: true,
    provider: 'deepgram',
    model,
    text: result.text,
    language: toTurnLanguage(result.detectedLanguage),
    detectedLanguage: result.detectedLanguage,
    languageConfidence: result.languageConfidence,
    confidence: result.confidence,
    durationSec: result.durationSec,
    bytes,
    mimetype,
    sttMs: now() - startedAt,
    providerMs,
    status,
  };
}
