/**
 * coexistirVoiceStream — the WebSocket half of the door's streaming ear.
 *
 * The browser opens ONE socket while MIC is on and pushes 16-bit mono PCM at
 * 16 kHz. This route holds the Deepgram socket (the key is read from the server
 * environment and never crosses to the page, review #7), relays audio upstream
 * and provider frames downstream, and decides nothing about words.
 *
 * Why a proxy instead of the page talking to Deepgram directly:
 *   - the browser would need the API key (it cannot: it is a public kiosk);
 *   - the door's language rule (`resolveDoorLanguage`) and the house log
 *     (`recordStt`) live on the server, and every spoken turn must leave the
 *     same audit trail whether it arrived as a clip or as a stream;
 *   - the provider's endpointing is the only end-of-turn signal, so it has to be
 *     observable from the side that owns the socket.
 *
 * Wire protocol (JSON text frames unless noted):
 *
 *   client -> proxy
 *     <binary>                    16-bit LE mono PCM, 16 kHz, back to back
 *     {t:'reset'}                 mic off / barge-in: drop partial text
 *     {t:'finalize'}              force the provider to close what it has
 *     {t:'ping'}                  liveness (answered with {t:'pong'})
 *
 *   proxy -> client
 *     {t:'ready', ...}            socket open upstream; carries the timings
 *     {t:'speech_started', audioMs}
 *     {t:'interim', text, audioMs}
 *     {t:'final', text, audioMs, speechFinal, lastWordEndMs}
 *     {t:'utterance_end', lastWordEndMs}
 *     {t:'turn', ...}             END OF TURN — the page answers this
 *     {t:'error', code, message}
 *     {t:'closed', reason}
 *
 * `audioMs` is an AUDIO clock (bytes received / 32), not wall time: it is the
 * position in what the visitor said, which is the only honest base for "how long
 * after the last word did the words come back".
 *
 * The relay is injectable (`openStreamImpl`, `clock`, `store`) so the protocol
 * is unit-tested against a fake provider with no network and no vendor.
 */

import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BYTES_PER_MS,
  STREAM_DEFAULTS,
  StreamSession,
  openDeepgramStream,
  type StreamConfig,
  type StreamEvent,
  type StreamTransport,
  type StreamTurn,
} from '../modules/voice/deepgramStream';
import { resolveDoorLanguage, type DoorLanguageDecision } from '../modules/voice/doorLanguage';
import {
  newTurnId,
  recordStt,
  resolveHouseDir,
  type HouseStore,
} from '../modules/voice/houseTranscript';

/** Where the door's socket lives. Kept in one place: index.ts and the client agree. */
export const STT_STREAM_PATH = '/api/coexistir/voice/stt-stream';

/** Audio the relay will accept on one socket before assuming the client is broken. */
const MAX_BYTES_PER_SECOND_SOCKET = 64 * 1024 * 1024;

/** A socket with no audio and no frames is a dead page; close it. */
const IDLE_CLOSE_MS = 120_000;

/** Keep-alive period upstream. Deepgram drops a silent socket at ~10 s. */
const KEEPALIVE_MS = 5_000;

export interface SttStreamRelayDeps {
  /** Injectable upstream (tests use a fake transport). */
  openStreamImpl?: typeof openDeepgramStream;
  /** House log root; defaults to the real one. */
  store?: HouseStore;
  clock?: () => number;
  /** Key override; defaults to `DEEPGRAM_API_KEY` inside the stream module. */
  apiKey?: string;
  config?: Partial<StreamConfig>;
  logger?: (line: string) => void;
  /** Room tag written on the house rows. */
  room?: string;
}

interface ClientControl {
  t?: string;
}

export interface SttStreamRelay {
  readonly path: string;
  /** True when an upgrade request belongs to this relay. */
  matches: (req: IncomingMessage) => boolean;
  /** Complete the upgrade and start relaying. */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Live connection count (health + tests). */
  size: () => number;
  close: () => Promise<void>;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url || '/', 'http://relay').pathname;
  } catch {
    return '';
  }
}

function msFromSec(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000);
}

/**
 * Build the relay. Nothing is listening until `upgrade()` is called on it, and
 * `attachCoexistirSttStream` is what wires that to an HTTP server.
 */
export function createSttStreamRelay(deps: SttStreamRelayDeps = {}): SttStreamRelay {
  const openStream = deps.openStreamImpl ?? openDeepgramStream;
  const clock = deps.clock ?? Date.now;
  const store = deps.store ?? resolveHouseDir();
  const logger = deps.logger ?? ((line: string) => console.log(line));
  const room = deps.room ?? 'coexistir';
  const config: StreamConfig = { ...STREAM_DEFAULTS, ...(deps.config ?? {}) };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  wss.on('connection', (client: WebSocket, req: IncomingMessage) => {
    const requested = (() => {
      try {
        return new URL(req.url || '/', 'http://relay').searchParams;
      } catch {
        return new URLSearchParams();
      }
    })();
    const languageParam = (requested.get('language') || 'auto').trim() || 'auto';
    const roomParam = requested.get('room') || room;
    const session = new StreamSession(clock);
    let closed = false;
    let bytesIn = 0;
    let audioEpochAt: number | null = null;
    let lastActivityAt = clock();
    let upstream: StreamTransport | null = null;

    const send = (payload: Record<string, unknown>) => {
      if (closed) return;
      try {
        client.send(JSON.stringify(payload));
      } catch {
        /* peer already gone */
      }
    };

    const finish = (reason: string) => {
      if (closed) return;
      closed = true;
      clearInterval(idle);
      clearInterval(ping);
      logger(
        `[stt-stream] close reason=${reason} bytes=${bytesIn} audio=${audioMs()}ms ` +
          `turns=${session.stats.turns} lang=${languageParam}`,
      );
      try {
        upstream?.close(1000, reason);
      } catch {
        /* already gone */
      }
      send({ t: 'closed', reason });
      try {
        client.close(1000, reason);
      } catch {
        /* already gone */
      }
    };

    /** Audio clock position of the byte stream, in ms. */
    const audioMs = () => Math.round(bytesIn / BYTES_PER_MS);

    /** Wall-clock latency from an audio position to now. */
    const sinceAudio = (audioPositionMs: number | null): number | null => {
      if (audioPositionMs === null || audioEpochAt === null) return null;
      return Math.max(0, Math.round(clock() - (audioEpochAt + audioPositionMs)));
    };

    const onProviderEvent = (event: StreamEvent) => {
      lastActivityAt = clock();
      switch (event.type) {
        case 'interim':
          send({ t: 'interim', text: event.text, audioMs: msFromSec(event.audioSec) });
          return;
        case 'speech_started':
          send({ t: 'speech_started', audioMs: msFromSec(event.audioSec) });
          return;
        case 'final':
          send({
            t: 'final',
            text: event.text,
            audioMs: msFromSec(event.audioSec),
            speechFinal: event.speechFinal,
            lastWordEndMs: msFromSec(event.wordsEndSec),
            confidence: event.confidence,
            detectedLanguage: event.detectedLanguage,
          });
          break;
        case 'utterance_end':
          send({ t: 'utterance_end', lastWordEndMs: msFromSec(event.lastWordEndSec) });
          break;
        case 'error':
          send({ t: 'error', code: event.code ?? 'provider', message: event.message });
          break;
        default:
          break;
      }

      const turn = session.handle(event);
      if (!turn) return;
      publishTurn(turn);
    };

    const publishTurn = (turn: StreamTurn) => {
      const decision: DoorLanguageDecision = resolveDoorLanguage({
        detected: turn.detectedLanguage,
        confidence: turn.languageConfidence,
        text: turn.text,
        requested: languageParam,
      });
      const turnId = newTurnId();
      const lastWordEndMs = msFromSec(turn.lastWordEndSec);
      // The streaming analogue of the batch `sttMs`: provider endpointing +
      // relay time, measured from where the last word ended on the audio clock.
      const sttMs = sinceAudio(lastWordEndMs) ?? 0;

      send({
        t: 'turn',
        turnId,
        text: turn.text,
        by: turn.by,
        language: decision.language,
        detectedLanguage: turn.detectedLanguage,
        languageConfidence: turn.languageConfidence,
        confidence: turn.confidence,
        languageDecision: decision,
        audio: {
          speechStartMs: msFromSec(turn.speechStartSec),
          lastWordEndMs,
          atMs: msFromSec(turn.audioSec),
        },
        finals: turn.finals,
        finalsSpanMs: turn.finalsSpanMs,
        sttMs,
        mode: 'stream',
      });

      try {
        recordStt(
          {
            room: roomParam,
            language: languageParam,
            detectedLanguage: turn.detectedLanguage,
            text: turn.text,
            confidence: turn.confidence,
            languageConfidence: turn.languageConfidence,
            durationSec:
              turn.lastWordEndSec !== null && turn.speechStartSec !== null
                ? Math.max(0, Number((turn.lastWordEndSec - turn.speechStartSec).toFixed(2)))
                : null,
            bytes: bytesIn,
            mimetype: 'audio/pcm;rate=16000',
            sttMs,
            providerMs: sttMs,
            model: config.model,
            ok: true,
            reason: null,
            doorLanguage: decision.language,
            detectedTurnLanguage: decision.detectedTurnLanguage,
            languageReason: decision.reason,
          },
          store,
        );
      } catch (err) {
        logger(
          `[stt-stream] house row failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      logger(
        `[stt-stream] turn ${turnId} by=${turn.by} stt=${sttMs}ms finals=${turn.finals} ` +
          `audio=${audioMs()}ms lang=${decision.language} "${turn.text.slice(0, 80)}"`,
      );
    };

    // Timers are created BEFORE the upstream socket: `finish()` and the keepalive
    // interval both close over them, and a provider that fails synchronously
    // (no key) must be able to tear the connection down without a TDZ error.
    const idle = setInterval(() => {
      if (closed) return;
      if (bytesIn > MAX_BYTES_PER_SECOND_SOCKET) {
        finish('audio_cap');
        return;
      }
      if (clock() - lastActivityAt > IDLE_CLOSE_MS) finish('idle');
    }, 5_000);
    idle.unref?.();

    const ping = setInterval(() => {
      if (closed) return;
      // Only hold the upstream open when the page is quiet; while audio flows the
      // provider sees frames anyway.
      if (clock() - lastActivityAt > KEEPALIVE_MS - 500) upstream?.keepAlive();
    }, KEEPALIVE_MS);
    ping.unref?.();

    client.on('message', (raw: unknown, isBinary: boolean) => {
      if (closed) return;
      lastActivityAt = clock();
      const binary = Array.isArray(raw)
        ? Buffer.concat(raw as Buffer[])
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw as ArrayBuffer);
      if (isBinary) {
        if (audioEpochAt === null) audioEpochAt = clock();
        bytesIn += binary.byteLength;
        upstream?.send(binary);
        return;
      }
      let control: ClientControl | null = null;
      try {
        control = JSON.parse(binary.toString('utf8')) as ClientControl;
      } catch {
        return;
      }
      if (control?.t === 'reset') {
        session.reset();
        return;
      }
      if (control?.t === 'finalize') {
        upstream?.finalize();
        return;
      }
      if (control?.t === 'ping') {
        send({ t: 'pong', audioMs: audioMs() });
      }
    });

    client.on('close', () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(idle);
      clearInterval(ping);
      logger(
        `[stt-stream] close reason=client-closed bytes=${bytesIn} audio=${audioMs()}ms ` +
          `turns=${session.stats.turns} lang=${languageParam}`,
      );
      upstream?.close(1000, 'client closed');
    });

    client.on('error', (err: Error) => {
      logger(`[stt-stream] client error: ${err.message}`);
    });

    upstream = openStream({
      apiKey: deps.apiKey,
      config: { ...config, language: languageParam },
      onEvent: onProviderEvent,
      onOpen: () => {
        // One line per socket: the live door's log could not tell "no relay
        // connection" from "a relay connection that heard silence", which is
        // exactly the question a live no-transcription report asks.
        logger(
          `[stt-stream] open room=${roomParam} lang=${languageParam} model=${config.model} ` +
            `ep=${config.endpointing}ms utteranceEnd=${config.utteranceEndMs}ms`,
        );
        send({
          t: 'ready',
          mode: 'stream',
          model: config.model,
          sampleRate: config.sampleRate,
          endpointing: config.endpointing,
          utteranceEndMs: config.utteranceEndMs,
          language: languageParam,
          room: roomParam,
        });
      },
      onError: (message) => {
        const code = message === 'no_key' ? 'no_key' : 'provider';
        send({ t: 'error', code, message });
        // No key is terminal for the stream path: the page must fall back to the
        // batch ear, so close rather than leave a half-open socket.
        if (code === 'no_key') finish('no_key');
      },
      onClose: (code, reason) => {
        if (closed) return;
        send({ t: 'closed', reason: reason ?? 'upstream closed', code });
        closed = true;
        clearInterval(idle);
        clearInterval(ping);
        try {
          client.close(1000, 'upstream closed');
        } catch {
          /* already gone */
        }
      },
    });

    if (config.utteranceEndMs <= config.endpointing) {
      // `utterance_end_ms` earlier than endpointing would fire first every time
      // and make the two signals indistinguishable in the log.
      logger(
        `[stt-stream] utteranceEndMs (${config.utteranceEndMs}) <= endpointing (${config.endpointing}); ` +
          'utterance_end will dominate',
      );
    }
  });

  return {
    path: STT_STREAM_PATH,
    matches(req: IncomingMessage) {
      return pathOf(req) === STT_STREAM_PATH;
    },
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
    size() {
      return wss.clients.size;
    },
    async close() {
      for (const client of wss.clients) {
        try {
          client.close(1000, 'server closing');
        } catch {
          /* already gone */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Attach the relay to an HTTP server that other code ALREADY owns.
 *
 * The Castalia server gives its `upgrade` event to Colyseus (`WebSocketTransport`
 * constructs a `WebSocketServer({ server })`), and a second `WebSocketServer`
 * would complete a second handshake on the same socket, corrupting both. So the
 * existing listeners are captured and re-dispatched, exactly the way
 * `patchColyseusBodyBuffering` handles `request`: our path goes to the relay,
 * everything else goes to the listeners that were there before us.
 *
 * Returns a detach function (restores the original listeners) — used by tests
 * that must not leak a listener between suites.
 */
export function attachCoexistirSttStream(
  server: HttpServer,
  deps: SttStreamRelayDeps = {},
): { relay: SttStreamRelay; detach: () => void } {
  const relay = createSttStreamRelay(deps);
  const saved = server.rawListeners('upgrade') as Array<(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void>;

  server.removeAllListeners('upgrade');
  const dispatcher = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (relay.matches(req)) {
      try {
        relay.upgrade(req, socket, head);
      } catch (err) {
        deps.logger?.(
          `[stt-stream] upgrade failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        socket.destroy();
      }
      return;
    }
    for (const fn of saved) fn.call(server, req, socket, head);
  };
  server.on('upgrade', dispatcher);

  return {
    relay,
    detach() {
      server.off('upgrade', dispatcher);
      server.removeAllListeners('upgrade');
      for (const fn of saved) server.on('upgrade', fn);
    },
  };
}

/**
 * `GET /api/coexistir/voice/stt-stream` — what the door asks before it opens a
 * socket: is the stream path available, and with which endpointing numbers?
 *
 * A page that gets `available: false` keeps the batch ear. A page that gets
 * `available: true` must still be able to fall back: the socket can fail for
 * reasons this route cannot know (a proxy in between, a lost key at runtime).
 */
export function sttStreamInfo(
  respond: (body: Record<string, unknown>) => void,
  deps: SttStreamRelayDeps = {},
): void {
  const config: StreamConfig = { ...STREAM_DEFAULTS, ...(deps.config ?? {}) };
  const key = deps.apiKey !== undefined ? deps.apiKey : process.env.DEEPGRAM_API_KEY || '';
  respond({
    ok: true,
    available: key.length > 0,
    mode: 'stream',
    path: STT_STREAM_PATH,
    model: config.model,
    sampleRate: config.sampleRate,
    encoding: 'linear16',
    endpointing: config.endpointing,
    utteranceEndMs: config.utteranceEndMs,
    /** Where end-of-turn comes from, stated for the debug rail. */
    endOfTurn: 'provider-endpointing',
    provider: 'deepgram',
  });
}
