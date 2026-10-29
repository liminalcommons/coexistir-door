/**
 * ttsStream — synthesize speech and push each provider chunk to the client as
 * it arrives.
 *
 * Why this exists: the historical `/api/tts/preview` route awaits the WHOLE
 * clip (`await response.arrayBuffer()`) and then `res.send(buffer)`. Measured
 * on the rig that holds 6–14s of silence before the first byte and cannot be
 * interrupted, because by the time the browser sees anything the provider call
 * is already over. Deepgram's engine itself delivers audio in 250–500ms and
 * stops cleanly when the connection closes — the buffering was ours.
 *
 * Contract:
 * - headers are flushed as soon as the provider accepts the request (before any
 *   audio), so the browser can start its player and the caller can time TTFB;
 * - every body chunk is written straight through (`res.write`), never collected;
 * - when the client disconnects (barge-in) the upstream fetch is aborted, so the
 *   provider stops generating instead of burning the rest of the clip;
 * - a `TtsStreamEvent` trace is emitted for TTFA/abort accounting.
 *
 * The module takes its `fetch` and clock by injection so the whole timing
 * contract is testable without network or wall-clock flakiness.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import { dirname } from 'path';
import type { Response } from 'express';
import {
  AGENT_VOICE_PROFILES,
  deepgramEndpointFor,
  deepgramModelId,
  resolveVoiceForLanguage,
  type VoiceConfig,
  type VoiceVariant,
} from './voiceProfiles';

export interface TtsStreamRequest {
  text: string;
  /** Pre-configured agent id (`coexistir-manager`); preferred over voiceConfig. */
  agentId?: string;
  /** BCP-47 tag. Defaults to the profile's own language (pt-BR for Mariana). */
  language?: string;
  /** Explicit voice override (used by tests and by non-profile callers). */
  voiceConfig?: VoiceConfig | VoiceVariant;
  /** Express response to stream into. */
  res: Response;
  /** Optional caller abort (route wires `req.on('close')` into this). */
  signal?: AbortSignal;
  /** Clock, injectable for tests. Returns epoch ms. */
  now?: () => number;
  /** Absolute path: tee the generated audio here (partial file survives abort). */
  teePath?: string | null;
  /** Extra response headers set before the flush (e.g. X-Turn-Id). */
  extraHeaders?: Record<string, string>;
  /** Provider fetch, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Called once with the final accounting (after end or abort). */
  onDone?: (event: TtsStreamEvent) => void;
}

export interface TtsStreamEvent {
  provider: string;
  modelId: string;
  voiceId: string;
  language: string;
  /** ms from handler entry to provider response headers. */
  upstreamMs: number;
  /** ms from handler entry to the first body chunk arriving from the provider. */
  firstChunkMs: number;
  /** ms from handler entry to `flushHeaders()` (client-visible TTFB). */
  headersFlushedMs: number;
  /** ms from handler entry to the last chunk written (or to the abort). */
  totalMs: number;
  bytes: number;
  chunks: number;
  aborted: boolean;
  /** ms from handler entry to the abort signal / client close. */
  abortMs?: number;
  /** True when the provider answered non-2xx (body then carries the error). */
  upstreamError?: string;
}

/** Thrown when a language has no voice — the route turns this into a 422. */
export class UnsupportedLanguageError extends Error {
  readonly requested: string;
  readonly supported: string[];
  constructor(requested: string, supported: string[]) {
    super(`no voice for language "${requested}"`);
    this.name = 'UnsupportedLanguageError';
    this.requested = requested;
    this.supported = supported;
  }
}

/** Thrown when the provider refuses the request (status + body snippet). */
export class TtsProviderError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = 'TtsProviderError';
    this.status = status;
    this.detail = detail;
  }
}

interface ResolvedStreamVoice {
  variant: VoiceVariant;
  language: string;
}

/** Resolve (agentId, language) -> the voice that will actually speak. */
export function resolveStreamVoice(
  agentId?: string,
  language?: string,
  voiceConfig?: VoiceConfig | VoiceVariant,
): ResolvedStreamVoice {
  if (agentId && AGENT_VOICE_PROFILES[agentId]) {
    const resolution = resolveVoiceForLanguage(AGENT_VOICE_PROFILES[agentId], language);
    if (resolution.ok === false) {
      throw new UnsupportedLanguageError(resolution.requested, resolution.supported);
    }
    return { variant: resolution.variant, language: resolution.language };
  }
  if (voiceConfig) {
    return {
      variant: {
        provider: voiceConfig.provider,
        voiceId: voiceConfig.voiceId || '',
        modelId: voiceConfig.modelId || '',
      },
      // Keep the caller's tag casing ('pt-BR'); Cartesia echoes it back.
      language: voiceConfig.language || language || 'en',
    };
  }
  const profile = AGENT_VOICE_PROFILES['coexistir-manager'];
  const resolution = resolveVoiceForLanguage(profile, language);
  if (resolution.ok === false) {
    throw new UnsupportedLanguageError(resolution.requested, resolution.supported);
  }
  return { variant: resolution.variant, language: resolution.language };
}

function providerRequest(
  text: string,
  variant: VoiceVariant,
): { url: string; headers: Record<string, string>; body: string } {
  if (variant.provider === 'deepgram') {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new Error('Deepgram API key not configured. Set DEEPGRAM_API_KEY.');
    const model = deepgramModelId(variant);
    const { url } = deepgramEndpointFor(model);
    return {
      url,
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      // Deepgram gets plain text — Flux rejects SSML tags.
      body: JSON.stringify({ text }),
    };
  }
  if (variant.provider === 'cartesia') {
    const apiKey = process.env.CARTESIA_API_KEY;
    if (!apiKey) throw new Error('Cartesia API key not configured. Set CARTESIA_API_KEY.');
    const model = variant.modelId?.startsWith('sonic-') ? variant.modelId : `sonic-${variant.modelId || '3'}`;
    return {
      url: 'https://api.cartesia.ai/tts/bytes',
      headers: {
        'X-API-Key': apiKey,
        'Cartesia-Version': '2025-04-16',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: model,
        transcript: text,
        voice: { mode: 'id', id: variant.voiceId || 'f786b574-daa5-4673-aa0c-cbe3e8534c02' },
        language: variant.language || 'en',
        output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
        generation_config: { speed: 0.95 },
      }),
    };
  }
  throw new Error(`Streaming TTS not implemented for provider "${variant.provider}"`);
}

/**
 * Stream one clip into `res`. Never throws after headers are flushed: fatal
 * mid-stream errors destroy the socket so the client sees a truncated response
 * instead of a hung one.
 */
export async function streamTts(request: TtsStreamRequest): Promise<TtsStreamEvent> {
  const now = request.now ?? Date.now;
  const fetchImpl = request.fetchImpl ?? fetch;
  const startedAt = now();

  // Resolve before touching the response: an unsupported language must still be
  // a clean 422, not a half-written audio body.
  let resolved: ResolvedStreamVoice;
  try {
    resolved = resolveStreamVoice(request.agentId, request.language, request.voiceConfig);
  } catch (error) {
    if (error instanceof UnsupportedLanguageError) {
      request.res.status(422).json({
        error: 'unsupported_language',
        requestedLanguage: error.requested,
        supportedLanguages: error.supported,
      });
      const rejection: TtsStreamEvent = {
        provider: 'none',
        modelId: '',
        voiceId: '',
        language: (request.language || '').trim(),
        upstreamMs: 0,
        firstChunkMs: 0,
        headersFlushedMs: 0,
        totalMs: now() - startedAt,
        bytes: 0,
        chunks: 0,
        aborted: false,
        upstreamError: error.message,
      };
      request.onDone?.(rejection);
      return rejection;
    }
    throw error;
  }
  const { variant, language } = resolved;
  const modelId = variant.provider === 'deepgram' ? deepgramModelId(variant) : variant.modelId;
  const { url, headers, body } = providerRequest(request.text, variant);

  const controller = new AbortController();
  let clientClosed = false;
  let abortAt: number | undefined;

  const onClientClose = () => {
    if (request.res.writableEnded) return;
    if (clientClosed) return;
    clientClosed = true;
    abortAt = now();
    controller.abort();
  };
  request.res.on('close', onClientClose);
  if (request.signal) {
    if (request.signal.aborted) {
      clientClosed = true;
      abortAt = now();
      controller.abort();
    } else {
      request.signal.addEventListener('abort', () => {
        if (clientClosed) return;
        clientClosed = true;
        abortAt = now();
        controller.abort();
      }, { once: true });
    }
  }

  let tee: WriteStream | null = null;
  if (request.teePath) {
    try {
      mkdirSync(dirname(request.teePath), { recursive: true });
      tee = createWriteStream(request.teePath);
      // A tee failure must never take the audio down; drop the file, keep the stream.
      tee.on('error', () => { tee = null; });
    } catch {
      tee = null;
    }
  }

  const event: TtsStreamEvent = {
    provider: variant.provider,
    modelId,
    voiceId: variant.voiceId,
    language,
    upstreamMs: 0,
    firstChunkMs: 0,
    headersFlushedMs: 0,
    totalMs: 0,
    bytes: 0,
    chunks: 0,
    aborted: false,
  };

  let headersFlushed = false;
  try {
    const upstream = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    event.upstreamMs = now() - startedAt;

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw new TtsProviderError(
        `TTS provider error: ${upstream.status} - ${detail.slice(0, 300)}`,
        upstream.status,
        detail,
      );
    }

    // Headers go out before the body so the client can open its player now.
    request.res.status(200);
    request.res.setHeader('Content-Type', 'audio/mpeg');
    request.res.setHeader('Cache-Control', 'no-store');
    request.res.setHeader('Transfer-Encoding', 'chunked');
    request.res.setHeader('X-TTS-Provider', variant.provider);
    request.res.setHeader('X-TTS-Voice-Id', variant.voiceId);
    request.res.setHeader('X-TTS-Model-Id', modelId);
    request.res.setHeader('X-TTS-Language', language);
    request.res.setHeader(
      'Access-Control-Expose-Headers',
      'X-TTS-Provider, X-TTS-Voice-Id, X-TTS-Model-Id, X-TTS-Language, X-Turn-Id',
    );
    for (const [name, value] of Object.entries(request.extraHeaders ?? {})) {
      request.res.setHeader(name, value);
    }
    // Small chunks must leave immediately: Nagle would coalesce them into the
    // 40ms-delayed ACK pattern that makes a streaming bridge look buffered.
    try {
      (request.res.socket as unknown as { setNoDelay?: (v: boolean) => void } | null)?.setNoDelay?.(true);
    } catch {
      /* socket already detached */
    }
    request.res.flushHeaders?.();
    headersFlushed = true;
    event.headersFlushedMs = now() - startedAt;

    const reader = upstream.body?.getReader();
    if (!reader) throw new TtsProviderError('TTS provider returned no body', 502, '');

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (event.chunks === 0) event.firstChunkMs = now() - startedAt;
      event.chunks += 1;
      event.bytes += value.length;
      if (tee) tee.write(Buffer.from(value));
      if (!request.res.write(Buffer.from(value))) {
        // Backpressure: wait for drain, but treat a closed client as an abort.
        await new Promise<void>((resolve) => {
          const finish = () => resolve();
          request.res.once('drain', finish);
          request.res.once('close', finish);
        });
      }
      if (clientClosed) break;
    }

    event.aborted = clientClosed;
    if (clientClosed) event.abortMs = (abortAt ?? now()) - startedAt;
    event.totalMs = now() - startedAt;
    if (!clientClosed) request.res.end();
  } catch (error) {
    event.aborted = clientClosed;
    if (clientClosed) {
      event.abortMs = (abortAt ?? now()) - startedAt;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      event.upstreamError = message;
      if (!headersFlushed) {
        // Nothing written yet: the route can still send a clean error status.
        request.res.removeListener('close', onClientClose);
        if (error instanceof TtsProviderError) {
          request.res.status(error.status === 429 ? 429 : 502).json({
            error: 'tts_provider_error',
            status: error.status,
            detail: error.detail.slice(0, 300),
          });
        } else {
          request.res.status(500).json({ error: message });
        }
        event.totalMs = now() - startedAt;
        tee?.end();
        request.onDone?.(event);
        return event;
      }
      // Mid-stream: truncate honestly rather than hang the player.
      request.res.destroy();
    }
    event.totalMs = now() - startedAt;
  } finally {
    request.res.removeListener('close', onClientClose);
    if (tee) {
      const t = tee;
      await new Promise<void>((resolve) => t.end(resolve));
    }
  }

  if (event.aborted) {
    event.totalMs = event.abortMs ?? event.totalMs;
  }
  request.onDone?.(event);
  return event;
}
