/**
 * coexistirVoiceRoutes — the realtime voice bridge for the front door.
 *
 * Three endpoints, one turn id:
 *
 *   POST /api/coexistir/voice/stt      recorded clip in -> transcript + language
 *                                      (+ a voice fingerprint, computed from the
 *                                      same bytes while the provider is thinking)
 *   POST /api/coexistir/voice/turn     text in -> ordered speak plan out
 *                                      ([filler?, answer]) + house-log row that
 *                                      now carries speaker + claim + voice
 *   POST /api/coexistir/voice/stream   text -> chunked audio (Deepgram Flux/Aura),
 *                                      first chunk written as it arrives, aborts
 *                                      upstream when the client goes away
 *   GET  /api/coexistir/voice/turns    the house log rows (what Hermes reads)
 *   GET  /api/coexistir/voice/id/latest    live fingerprint for the debug rail
 *   GET  /api/coexistir/voice/id/events    the append-only fingerprint rows
 *   GET  /api/coexistir/voice/id/stream    SSE: observed / claim / attached
 *   GET  /api/coexistir/voice/consult/pending   hard questions awaiting Hermes
 *   POST /api/coexistir/voice/consult/answer    where Hermes writes its answer
 *
 * The `id/*` reads are data for the debug panel (which owns the pixels) and are
 * closed unless the request carries `?debug=1` — the same gate the door uses
 * for its rail.
 *
 * Design law: the room never pretends Hermes is synchronous. A hard question
 * gets an honest filler now, a data answer when data exists, and a queued
 * consult row for everything the household brain must answer later.
 *
 * The router is a factory so tests inject the streamer, talker, task store and
 * house directory — no network, no Mongo, no wall clock.
 */

import express, { Request, Response } from 'express';
import { join } from 'path';
import {
  COEXISTIR_TASK_ZONE,
  CoexistirTaskRepository,
  type TaskRepositoryLike,
} from '../modules/coexistir/CoexistirTaskRepository';
import {
  composeManagerTurn,
  MANAGER_INTENTS,
  normalizeManagerIntent,
  normalizeManagerLanguage,
  type ManagerIntent,
} from '../modules/coexistir/managerPersona';
import { resolveClaimDisplayName } from '../modules/naming/claimDisplayName';
import {
  peekIdentity,
  refreshIdentity,
  ensureIdentity,
  type VoiceIdentity,
} from '../modules/naming/voiceIdentity';
import { describeAcoustics } from '../modules/voice/acousticSnapshot';
import {
  CONSULT_ACK,
  classifyTurn,
  askTalker,
  normalizeLanguage,
  pickFiller,
  REFLEX_MODEL,
  type TalkerResult,
  type TurnKind,
} from '../modules/coexistir/reflexTalker';
import {
  answerConsult,
  audioRefFor,
  houseInventory,
  newTurnId,
  pendingConsults,
  queueConsult,
  readAllEvents,
  readTurns,
  readVoiceIdRows,
  recordAudio,
  recordStt,
  recordTurn,
  recordVoice,
  resolveHouseDir,
  type HouseStore,
  type TurnClaim,
  type TurnVoice,
} from '../modules/voice/houseTranscript';
import {
  DEFAULT_MATCH_THRESHOLD,
  VOICEPRINT_DIMS,
  VoiceprintRegistry,
  emptyFingerprint,
  identifyVoice,
  type VoiceFingerprint,
} from '../modules/voice/voiceIdentity';
import {
  VoiceIdBus,
  observationFrom,
  voiceIdBus,
  newVoiceTraceId,
  type VoiceClaimView,
  type VoiceIdEvent,
  type VoiceIdObservation,
} from '../modules/voice/voiceIdBus';
import { transcribeAudio, warmStt, type TranscribeResult } from '../modules/voice/deepgramStt';
import { describeDoorLanguage, resolveDoorLanguage } from '../modules/voice/doorLanguage';
import { sttStreamInfo } from './coexistirVoiceStream';
import { streamTts, type TtsStreamEvent } from '../modules/voice/ttsStream';
import {
  ENROLL_MAX_CLIPS,
  ENROLL_PROMPTS,
  EnrollmentStore,
  verifyAgainst,
  type EnrollmentSession,
} from '../modules/voice/enrollment';
import { getWeaverDb } from '../database/weaverDb';
import {
  knowledgeGroupForVoiceKey,
  normalizeClaimName,
} from '../modules/naming/voiceClaimPolicy';

export interface SpeakStep {
  role: 'filler' | 'answer';
  text: string;
  /** POST this to the stream route; the client plays the steps in order. */
  stream: {
    path: string;
    body: { text: string; language: string; agentId: string; turnId: string; kind: 'filler' | 'answer' };
  };
}

export interface CoexistirVoiceRouterDeps {
  taskRepo?: TaskRepositoryLike;
  resolveMemberName?: (voiceKey?: string, displayName?: string) => Promise<{ name?: string }>;
  /** Injectable streamer (tests use a fake that writes known chunks). */
  streamTtsImpl?: typeof streamTts;
  /** Injectable talker (tests avoid Groq + network latency). */
  askTalkerImpl?: (options: Parameters<typeof askTalker>[0]) => Promise<TalkerResult>;
  /** Injectable transcriber (tests avoid Deepgram + network latency). */
  transcribeImpl?: typeof transcribeAudio;
  /**
   * Voice identity from the clip the ear already receives. On by default;
   * `COEXISTIR_VOICE_ID=false` turns it off for a rig that cannot spare the CPU.
   */
  voiceId?: boolean;
  /** Cosine threshold for an enrolled match (default 0.82). */
  voiceMatchThreshold?: number;
  /** Injectable fingerprint/registry step (tests drive the real one). */
  identifyImpl?: typeof identifyVoice;
  /**
   * Claim lookup by voiceKey. Defaults to `voice_name_claims` in Mongo; tests
   * inject a pure function so no database is needed.
   */
  resolveClaimImpl?: (voiceKey: string) => Promise<VoiceClaimView | null>;
  /** The ear→turn bridge. One per process by default. */
  voiceBus?: VoiceIdBus;
  /**
   * Open the `/voice/id/*` debug endpoints. `?debug=1` always opens them (the
   * door's own gate); set this (or `COEXISTIR_VOICE_DEBUG=1`) to open them for
   * an internal panel that cannot add the query.
   */
  voiceDebug?: boolean;
  /**
   * Warm the STT connection at boot. Defaults to on outside tests; the first
   * visitor otherwise pays ~450 ms of DNS/TLS on their own question.
   */
  sttWarmup?: boolean;
  /** House log root; defaults to ~/.hermes/house/coexistir. */
  houseDir?: string;
  now?: () => Date;
  /** Monotonic-ish clock for timings (defaults to Date.now). */
  clock?: () => number;
  agentId?: string;
  /**
   * Identity port (claims cache). Injected by tests so the route never needs a
   * Mongo connection; in production this is the real `voiceIdentity` module.
   */
  identity?: {
    peek: (voiceKey: string) => VoiceIdentity;
    refresh: (voiceKey: string) => Promise<VoiceIdentity | null>;
    ensure: (voiceKey: string) => Promise<VoiceIdentity>;
  };
  /**
   * Enrollment sessions. One per process by default (in-memory, TTL'd); tests
   * inject their own so sessions never leak between suites.
   */
  enrollStore?: EnrollmentStore;
  /**
   * Where a finished enrollment files its name. Defaults to the
   * `voice_name_claims` collection in Mongo (verified, reason 'enrollment');
   * tests inject a pure function so no database is needed.
   */
  fileEnrollClaimImpl?: (claim: {
    voiceKey: string;
    claimedName: string;
    normalizedName: string;
    claimBy: string;
    printId: string;
    consistency: number;
    clips: number;
  }) => Promise<void>;
}

const MANAGER_AGENT_ID = 'coexistir-manager';

/** Where a turn's `speaker` came from — a claim, the caller, or nothing. */
export type TurnVoiceSource = 'claim' | 'client' | null;

/**
 * Turn a bus observation into the row the panel reads.
 *
 * `status: 'identified'` requires BOTH an enrolled voiceprint match and a
 * resolved name claim. A matched voice with no claim is `unenrolled` — the door
 * knows it has heard this voice, and refuses to name it. A clip too short or
 * silent to fingerprint is `empty`, not a guess.
 */
export function turnVoiceFrom(observation: VoiceIdObservation | null, now: number): TurnVoice {
  if (!observation) {
    return {
      status: 'no_audio',
      printId: null,
      voiceKey: null,
      matched: false,
      similarity: null,
      dims: null,
      ms: null,
      cpuMs: null,
      traceId: null,
      ageMs: null,
      claimStatus: 'none',
      threshold: null,
      source: 'wav-embedding',
    };
  }
  const status: TurnVoice['status'] =
    observation.status === 'identified'
      ? observation.claim
        ? 'identified'
        : 'unenrolled'
      : observation.status === 'no_audio' || observation.status === 'too_short'
        ? 'empty'
        : observation.status === 'disabled'
          ? 'disabled'
          : observation.status === 'error'
            ? 'error'
            : 'unenrolled';
  return {
    status,
    printId: observation.printId,
    voiceKey: observation.voiceKey,
    matched: observation.matched,
    similarity: observation.similarity,
    dims: observation.dims,
    ms: observation.ms,
    cpuMs: observation.cpuMs,
    traceId: observation.traceId,
    ageMs: Math.max(0, Math.round(now - observation.at)),
    claimStatus: observation.claimStatus,
    threshold: observation.threshold,
    source: 'wav-embedding',
  };
}


function seedFrom(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export function createCoexistirVoiceRouter(deps: CoexistirVoiceRouterDeps = {}): express.Router {
  const router = express.Router();
  const taskRepo = deps.taskRepo ?? new CoexistirTaskRepository();
  const ask = deps.askTalkerImpl ?? askTalker;
  const streamer = deps.streamTtsImpl ?? streamTts;
  const transcribe = deps.transcribeImpl ?? transcribeAudio;
  const nowDate = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => Date.now());
  const agentId = deps.agentId ?? MANAGER_AGENT_ID;
  const identityPort = deps.identity ?? {
    peek: peekIdentity,
    refresh: refreshIdentity,
    ensure: ensureIdentity,
  };
  const store: HouseStore = resolveHouseDir(deps.houseDir);

  // --- voice identity ------------------------------------------------------
  //
  // The clip arrives here for STT anyway, so identity costs no extra upload and
  // no extra request. Three rules keep it off the latency budget:
  //
  //   1. The provider call is ISSUED first (`transcribePromise`), then the
  //      fingerprint is queued on `setImmediate` — the CPU work happens while
  //      Deepgram is thinking, not before it is asked.
  //   2. The handler never awaits the fingerprint: it takes the value only if
  //      it already settled (`identity.settled()`), so `sttMs` is unchanged.
  //   3. Any claim lookup (Mongo) runs after that, fire-and-forget, and lands
  //      in the bus for `/turn` and for the debug stream.
  const voiceIdEnabled =
    deps.voiceId ??
    !['false', '0', 'off'].includes(String(process.env.COEXISTIR_VOICE_ID ?? '').toLowerCase());
  const envThreshold = Number.parseFloat(String(process.env.COEXISTIR_VOICE_MATCH ?? ''));
  const voiceThreshold =
    typeof deps.voiceMatchThreshold === 'number' && deps.voiceMatchThreshold > 0
      ? deps.voiceMatchThreshold
      : Number.isFinite(envThreshold) && envThreshold > 0
        ? envThreshold
        : DEFAULT_MATCH_THRESHOLD;
  const registry = new VoiceprintRegistry({ dir: store.dir, threshold: voiceThreshold });
  const bus: VoiceIdBus = deps.voiceBus ?? voiceIdBus;
  const identify = deps.identifyImpl ?? identifyVoice;
  const resolveClaim: (voiceKey: string) => Promise<VoiceClaimView | null> =
    deps.resolveClaimImpl ??
    (async (voiceKey: string) => {
      try {
        const claim = await resolveClaimDisplayName(voiceKey);
        return claim ? { name: claim.name, status: claim.status } : null;
      } catch {
        return null;
      }
    });

  const CLAIM_TTL_MS = 60_000;
  const CLAIM_MISS_TTL_MS = 10_000;
  const claimCache = new Map<string, { claim: VoiceClaimView | null; at: number }>();
  const claimInflight = new Map<string, Promise<VoiceClaimView | null>>();

  /** Cached claim, or undefined when this voice has not been looked up yet. */
  function cachedClaim(voiceKey: string): VoiceClaimView | null | undefined {
    const hit = claimCache.get(voiceKey);
    if (!hit) return undefined;
    const ttl = hit.claim ? CLAIM_TTL_MS : CLAIM_MISS_TTL_MS;
    if (Date.now() - hit.at > ttl) {
      claimCache.delete(voiceKey);
      return undefined;
    }
    return hit.claim;
  }

  /** Resolve (once per TTL, de-duplicated) the name claim behind a voiceKey. */
  function warmClaim(voiceKey: string): Promise<VoiceClaimView | null> {
    const cached = cachedClaim(voiceKey);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = claimInflight.get(voiceKey);
    if (inflight) return inflight;
    const pending = resolveClaim(voiceKey)
      .then((claim) => {
        claimCache.set(voiceKey, { claim, at: Date.now() });
        return claim;
      })
      .catch((err) => {
        console.warn(
          '[coexistirVoice] claim lookup failed:',
          err instanceof Error ? err.message : err,
        );
        claimCache.set(voiceKey, { claim: null, at: Date.now() });
        return null;
      })
      .finally(() => claimInflight.delete(voiceKey));
    claimInflight.set(voiceKey, pending);
    return pending;
  }

  interface IdentityJob {
    /** The fingerprint if it is already computed — never waits. */
    settled: () => VoiceFingerprint | null;
    done: Promise<VoiceFingerprint>;
  }

  function queueIdentity(audio: Buffer, mimetype: string): IdentityJob {
    let settled: VoiceFingerprint | null = null;
    let release!: (fingerprint: VoiceFingerprint) => void;
    const done = new Promise<VoiceFingerprint>((resolve) => {
      release = resolve;
    });
    setImmediate(() => {
      let fingerprint: VoiceFingerprint;
      try {
        fingerprint = identify({ audio, mimetype, registry });
      } catch (err) {
        fingerprint = emptyFingerprint(
          'error',
          err instanceof Error ? err.message : String(err),
          0,
          voiceThreshold,
        );
      }
      settled = fingerprint;
      release(fingerprint);
    });
    return { settled: () => settled, done };
  }

  /**
   * Publish an observation, let a claim land on it (async), and write the
   * voice-id row. Called fire-and-forget: nothing here delays the response.
   *
   * `attachable: false` (a clip the provider could not transcribe) still writes
   * the identity row for the debug panel but is NOT offered to a turn — a
   * failed ear must not lend a voice to whatever question comes next.
   */
  async function observeVoice(
    fingerprint: VoiceFingerprint,
    room: string,
    traceId: string,
    attachable = true,
  ): Promise<VoiceIdObservation> {
    const observation = observationFrom({ fingerprint, room, traceId, now: Date.now() });
    if (!attachable) {
      writeVoiceRow(observation, 'observed');
      return observation;
    }
    bus.put(observation);
    if (observation.voiceKey) {
      const claim = await warmClaim(observation.voiceKey);
      bus.setClaim(observation, claim, claim ? 'resolved' : 'none');
    }
    writeVoiceRow(observation, 'observed');
    return observation;
  }

  /** Append one voice-identity row; a failed append never breaks a turn. */
  function writeVoiceRow(observation: VoiceIdObservation, phase: 'observed' | 'attached'): void {
    try {
      recordVoice(
        {
          room: observation.room,
          traceId: observation.traceId,
          status: observation.status,
          printId: observation.printId,
          voiceKey: observation.voiceKey,
          matched: observation.matched,
          similarity: observation.similarity,
          dims: observation.dims,
          durationSec: observation.durationSec,
          voicedSec: observation.voicedSec,
          ms: observation.ms,
          cpuMs: observation.cpuMs,
          threshold: observation.threshold,
          newCluster: observation.newCluster,
          claim: observation.claim
            ? { ...observation.claim, voiceKey: observation.voiceKey ?? '', source: 'voice_name_claims' }
            : null,
          claimStatus: observation.claimStatus,
          phase,
          turnId: observation.turnId,
        },
        store,
      );
    } catch (err) {
      console.warn(
        '[coexistirVoice] voice-id row failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** `?debug=1` (the door's own gate) or an operator switch opens the id API. */
  function voiceDebugOpen(req: Request): boolean {
    if (deps.voiceDebug) return true;
    const query = String(req.query.debug ?? '').toLowerCase();
    if (query === '1' || query === 'true') return true;
    return ['1', 'true', 'on'].includes(
      String(process.env.COEXISTIR_VOICE_DEBUG ?? '').toLowerCase(),
    );
  }


  // Pay DNS + TLS once, now, instead of on the first visitor's question.
  const warmup =
    deps.sttWarmup ?? (process.env.NODE_ENV !== 'test' && process.env.STT_WARMUP !== 'false');
  if (warmup) {
    setTimeout(() => {
      const started = Date.now();
      void warmStt()
        .then((ok) => {
          console.log(
            `[coexistirVoice] stt warm-up ${ok ? 'ok' : 'failed'} in ${Date.now() - started} ms`,
          );
        })
        .catch(() => undefined);
    }, 1500).unref?.();
  }

  const resolveMemberName =
    deps.resolveMemberName ??
    (async (voiceKey?: string, displayName?: string) => {
      if (voiceKey) {
        try {
          const claim = await resolveClaimDisplayName(voiceKey);
          if (claim?.name) return { name: claim.name };
        } catch {
          /* claims DB optional — fall through to the display name */
        }
      }
      const fallback = (displayName ?? '').trim();
      return fallback ? { name: fallback } : {};
    });

  /**
   * Loop 1 + loop 2 for one turn. Nothing here waits on Hermes.
   */
  router.post('/turn', async (req: Request, res: Response) => {
    const startedAt = clock();
    const body = req.body as {
      text?: string;
      language?: string;
      voiceKey?: string;
      displayName?: string;
      room?: string;
      speaker?: string;
      intent?: string;
      seed?: number;
      /**
       * Optional pin: the `traceId` the ear returned with its transcript. The
       * door does not send it today (recency in the same room is enough), but
       * the seam exists so a client can make the link exact.
       */
      voiceTraceId?: string;
    };

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Missing text' });
      return;
    }

    const language = normalizeManagerLanguage(body.language ?? 'pt');
    // The talker, the fillers and the consult ack must run on the SAME resolved
    // language as the composed text. `normalizeLanguage(body.language)` turned a
    // missing language into 'en' — the exact leak that made a Portuguese door
    // speak its fillers in English.
    const talkLanguage = normalizeLanguage(language);
    const classification = classifyTurn(text, body.language);
    const turnId = newTurnId(nowDate().getTime());
    const room = typeof body.room === 'string' && body.room ? body.room : 'coexistir';
    const voiceKey =
      typeof body.voiceKey === 'string' && body.voiceKey.trim() ? body.voiceKey.trim() : null;
    /**
     * Who is speaking: kick the claim read in the background and use whatever is
     * warm when the row is written. This is the fix for `speaker: null` on every
     * door turn — the client never sent a display name, so the row recorded the
     * absence of one even when a name claim existed for the voice key.
     */
    if (voiceKey) void identityPort.refresh(voiceKey);
    const seed = Number.isFinite(body.seed) ? Number(body.seed) : seedFrom(text);

    // --- who spoke? ---------------------------------------------------------
    // The ear left an observation in the bus a few milliseconds ago (the same
    // clip that produced this text). Attaching it is a map lookup — no await,
    // no database, no added latency on the turn path.
    //
    // The link is "freshest unconsumed observation in this room, 20 s". One door
    // per room is the deployment; when two share a room, a client can pin it by
    // sending `voiceTraceId` (the `voice.traceId` the ear returned).
    const voiceObservation = voiceIdEnabled
      ? bus.attach(room, { turnId, traceId: body.voiceTraceId })
      : null;
    // An enrolled voice wins over the kiosk key from here on: warm its claim
    // snapshot so the NEXT turn reads it instead of reporting pending. The
    // kiosk key's own snapshot was already kicked above; this one is the
    // person behind the voice, and it is usually cold on first recognition.
    if (voiceObservation?.voiceKey) void identityPort.refresh(voiceObservation.voiceKey);
    const voice: TurnVoice = voiceIdEnabled
      ? turnVoiceFrom(voiceObservation, Date.now())
      : {
          status: 'disabled',
          printId: null,
          voiceKey: null,
          matched: false,
          similarity: null,
          dims: null,
          ms: null,
          cpuMs: null,
          traceId: null,
          ageMs: null,
          claimStatus: 'none',
          threshold: voiceThreshold,
          source: 'wav-embedding',
        };
    const claim: TurnClaim | null =
      voiceObservation?.claim && voiceObservation.voiceKey
        ? {
            name: voiceObservation.claim.name,
            status: voiceObservation.claim.status,
            voiceKey: voiceObservation.voiceKey,
            source: 'voice_name_claims',
          }
        : null;
    // Identity, not assertion: the observed voice wins over the kiosk key, and
    // the speaker name comes from the claim — the caller's `displayName` is a
    // last resort, labelled as such.
    const clientSpeaker = (body.speaker ?? body.displayName ?? '').trim() || null;
    const effectiveVoiceKey = voiceObservation?.voiceKey ?? body.voiceKey;

    const steps: SpeakStep[] = [];
    const kind: TurnKind = classification.kind;
    let filler: string | null = null;
    let answer = '';
    let model: string | null = null;
    let fallback = false;
    let talkerMs = 0;
    let composeMs = 0;
    let needsConsult = false;
    let consultQueued = false;
    let resolvedFrom: 'talker' | 'tasks' | 'consult-ack' = 'talker';
    let intent: ManagerIntent | null = null;
    const flags = [...classification.flags];

    const streamStep = (role: 'filler' | 'answer', stepText: string): SpeakStep => ({
      role,
      text: stepText,
      stream: {
        path: '/api/coexistir/voice/stream',
        body: { text: stepText, language, agentId, turnId, kind: role },
      },
    });

    if (kind === 'smalltalk') {
      const talker = await ask({ text, language, now: clock });
      talkerMs = talker.talkerMs;
      model = talker.model;
      fallback = talker.fallback;
      answer = talker.text;
      steps.push(streamStep('answer', answer));
    } else {
      // Loop 1: honest filler, immediately — the room is never silent.
      filler = pickFiller(talkLanguage, seed);
      steps.push(streamStep('filler', filler));

      // Loop 2a: a data intent composes from the SAME task rows the Tasks tab
      // writes, so the answer names real work instead of guessing.
      const wantsIntent =
        typeof body.intent === 'string' &&
        (MANAGER_INTENTS as readonly string[]).includes(normalizeManagerIntent(body.intent));
      if (wantsIntent) {
        intent = normalizeManagerIntent(body.intent);
        const composeStart = clock();
        try {
          const [tasks, member] = await Promise.all([
            taskRepo.list(COEXISTIR_TASK_ZONE),
            resolveMemberName(effectiveVoiceKey, body.displayName),
          ]);
          const turn = composeManagerTurn({
            intent,
            memberName: member.name,
            tasks,
            language,
            now: nowDate(),
            seed,
          });
          answer = turn.text;
          resolvedFrom = 'tasks';
        } catch (err) {
          console.warn('[coexistirVoice] task compose failed:', err instanceof Error ? err.message : err);
          answer = CONSULT_ACK[talkLanguage];
          resolvedFrom = 'consult-ack';
          needsConsult = true;
          flags.push('compose-failed');
        }
        composeMs = clock() - composeStart;
      } else {
        // Loop 2b: no data path — say so honestly and queue the question.
        answer = CONSULT_ACK[talkLanguage];
        resolvedFrom = 'consult-ack';
        needsConsult = true;
      }

      steps.push(streamStep('answer', answer));

      if (needsConsult) {
        queueConsult(
          {
            turnId,
            room,
            question: text,
            language,
            voiceKey: body.voiceKey ?? null,
            status: 'pending',
            reason: classification.reason,
            flags,
            immediateReply: answer,
          },
          store,
        );
        consultQueued = true;
      }
    }

    const totalMs = clock() - startedAt;
    // The identity snapshot held NOW (after the compose work above, so a warm
    // claim read usually lands in time). A cold cache is recorded as `pending`,
    // never as "no claim".
    const identity = voiceKey ? identityPort.peek(voiceKey) : null;
    // Two identity reads, one name. The bus claim is tied to THIS clip's
    // fingerprint (voice-ID slice); the naming snapshot is the warm claim cache
    // the panel reads (panels slice). The bus wins because it observed the
    // voice; the snapshot is the fallback when voice-ID is off or no
    // observation landed for this turn.
    const speaker = claim?.name ?? identity?.name ?? clientSpeaker;
    const speakerSource: TurnVoiceSource =
      claim || identity?.name ? 'claim' : clientSpeaker ? 'client' : null;
    recordTurn(
      {
        turnId,
        room,
        voiceKey: effectiveVoiceKey ?? null,
        speaker,
        identity,
        speakerSource,
        voice,
        claim,
        language,
        input: text,
        kind,
        filler,
        reply: answer,
        needsConsult,
        model,
        fallback,
        timings: { talkerMs, totalMs },
        audioRef: audioRefFor(turnId, 'answer'),
        reason: classification.reason,
        flags,
      },
      store,
    );

    // The append-only mirror of the attach: `voice-id.jsonl` gets a second row
    // for the same trace with `phase: 'attached'` and the turnId, so a panel
    // that only polls files still sees the join. Scheduled off the response.
    if (voiceObservation) {
      setImmediate(() => writeVoiceRow(voiceObservation, 'attached'));
    }

    res.json({
      turnId,
      kind,
      language,
      agentId,
      identity,
      classification: { reason: classification.reason, flags },
      sequence: steps,
      filler: filler === null ? null : steps.find((s) => s.role === 'filler')?.text ?? filler,
      answer,
      needsConsult,
      consultQueued,
      resolvedFrom,
      intent,
      model,
      fallback,
      // Who the ear heard, for the debug rail: never a guess, and `speaker` is
      // null unless a claim supplied a name.
      speaker,
      speakerSource,
      claim,
      voice,
      timings: { talkerMs, composeMs, totalMs },
      // Documented seam: the room answers what it can now; Hermes answers later.
      consult: {
        pending: needsConsult ? pendingConsults(store).length : 0,
        pendingPath: '/api/coexistir/voice/consult/pending',
        answerPath: '/api/coexistir/voice/consult/answer',
      },
    });
  });

  /**
   * The ear. One push-to-talk clip in, the words out.
   *
   * Raw body, not multipart: the browser already holds the recorder Blob, so
   * posting it directly is one fewer encode/parse on the door's link. The
   * transcript gets its own house-log row so "what was heard" sits on disk
   * beside the answer it produced — the debug panel and the harness read the
   * same timeline.
   *
   * This endpoint deliberately stops at the text. The words go into the existing
   * `/turn` route unchanged, which is what keeps detection, filler, task answer
   * and the consult queue on exactly one code path whether the question was
   * typed (old door) or spoken (this one).
   */
  router.post(
    '/stt',
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }),
    async (req: Request, res: Response) => {
      const startedAt = clock();
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (audio.length === 0) {
        res.status(400).json({
          ok: false,
          error: 'missing_audio',
          hint: 'POST the recorder blob with an audio/* content-type',
        });
        return;
      }

      const rawLanguage = typeof req.query.language === 'string' ? req.query.language.trim() : '';
      const language = rawLanguage && rawLanguage.toLowerCase() !== 'auto' ? rawLanguage : 'auto';
      const mimetype = String(req.headers['content-type'] || 'audio/webm').split(';')[0].trim();
      const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : 'coexistir';
      const voiceKey =
        typeof req.query.voiceKey === 'string' && req.query.voiceKey.trim()
          ? req.query.voiceKey.trim()
          : null;
      if (voiceKey) void identityPort.refresh(voiceKey);

      // A hasty double-tap that closes the socket must not keep a paid STT call
      // running against a transcript nobody will read. Watch the RESPONSE: on
      // Node the request's own 'close' fires as soon as its body is consumed,
      // which would abort every transcription instantly.
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', onClose);

      // Issue the provider call FIRST, then fingerprint on the next tick: the
      // analysis rides the STT wait instead of preceding it. `identity.settled()`
      // is read after the await and never blocks — that is the whole latency
      // story of this slice.
      const voiceTraceId = newVoiceTraceId();
      const transcribePromise = transcribe({
        audio,
        mimetype,
        language,
        now: clock,
        signal: abort.signal,
      });
      const identityJob = voiceIdEnabled ? queueIdentity(audio, mimetype) : null;

      let result: TranscribeResult;
      try {
        result = await transcribePromise;
      } catch (err) {
        // transcribeAudio resolves typed failures; a throw here is our bug.
        console.error('[coexistirVoice] stt failed:', err instanceof Error ? err.message : err);
        if (!res.headersSent) {
          res.status(500).json({
            ok: false,
            error: 'stt_failed',
            detail: err instanceof Error ? err.message : String(err),
            sttMs: clock() - startedAt,
          });
        }
        return;
      } finally {
        res.off('close', onClose);
      }

      const sttMs = clock() - startedAt;

      // Measured clip properties, on the WAV that was already in memory. This is
      // NOT a voiceprint (no embedding stage exists); it is recorded so the
      // panel can show what the clip actually measured instead of a fake match.
      const acoustic = describeAcoustics(audio);
      // The naming snapshot (claims + quorum counts) the panels slice reads.
      const identity = voiceKey ? identityPort.peek(voiceKey) : null;
      // The fingerprint, if it finished during the provider wait (measured
      // ~10–25 ms of CPU against a 110–320 ms network call). When it did not,
      // the response simply says `pending` and the observation is published
      // when it lands — identity is never allowed to become a wait.
      const fingerprint = identityJob?.settled() ?? null;
      const readyBeforeStt = fingerprint !== null;
      const voice = fingerprint;
      // A clip the provider could not transcribe still gets an identity row,
      // but it is not offered to a turn: an unheard question must not lend its
      // voice to whatever is asked next.
      const attachable = result.ok === true;
      if (identityJob && !fingerprint) {
        void identityJob.done
          .then((late) => observeVoice(late, room, voiceTraceId, attachable))
          .catch((err) =>
            console.warn(
              '[coexistirVoice] late fingerprint failed:',
              err instanceof Error ? err.message : err,
            ),
          );
      } else if (fingerprint) {
        void observeVoice(fingerprint, room, voiceTraceId, attachable).catch((err) =>
          console.warn(
            '[coexistirVoice] voice observation failed:',
            err instanceof Error ? err.message : err,
          ),
        );
      }

      // The provider's detection is advice, not a verdict: the door pins its
      // own language and only leaves it on positive EN evidence. This is the
      // single place the door decides, so a stale client bundle that still
      // reads `language` off this response picks the pin up too.
      const decision = result.ok
        ? resolveDoorLanguage({
            detected: result.detectedLanguage,
            confidence: result.languageConfidence,
            text: result.text,
            requested: language,
          })
        : null;
      if (decision?.overridden) {
        console.warn(
          `${describeDoorLanguage(decision)} — provider said ${decision.detected} over ` +
            `"${result.text.slice(0, 60)}"`,
        );
      }

      const claimAtStt = voice?.voiceKey ? cachedClaim(voice.voiceKey) : undefined;
      const claimView: VoiceClaimView | null = claimAtStt ?? null;
      const claimStatus: 'none' | 'pending' | 'resolved' = !voice?.voiceKey
        ? 'none'
        : claimAtStt === undefined
          ? 'pending'
          : claimAtStt
            ? 'resolved'
            : 'none';

      recordStt(
        {
          room,
          voiceKey: voiceKey ?? null,
          identity,
          acoustic,
          language,
          detectedLanguage: result.detectedLanguage,
          text: result.text,
          confidence: result.confidence,
          languageConfidence: result.languageConfidence,
          durationSec: result.durationSec,
          bytes: result.bytes,
          mimetype: result.mimetype,
          sttMs,
          providerMs: result.providerMs,
          model: result.model,
          ok: result.ok,
          reason: result.reason ?? null,
          doorLanguage: decision?.language ?? null,
          detectedTurnLanguage: decision?.detectedTurnLanguage ?? null,
          languageReason: decision?.reason ?? null,
          voice: voice
            ? {
                status: voice.status,
                printId: voice.printId,
                voiceKey: voice.voiceKey,
                matched: voice.matched,
                similarity: voice.similarity,
                dims: voice.dims,
                durationSec: voice.durationSec,
                voicedSec: voice.voicedSec,
                threshold: voice.threshold,
                ms: voice.ms,
                cpuMs: voice.cpuMs,
                claim: claimView
                  ? { ...claimView, voiceKey: voice.voiceKey ?? '', source: 'voice_name_claims' }
                  : null,
                claimStatus,
                traceId: voiceTraceId,
                readyBeforeStt,
              }
            : null,
        },
        store,
      );

      const status = result.ok ? 200 : result.reason === 'no_key' ? 503 : 502;
      res.setHeader('X-Stt-Ms', String(sttMs));
      res.setHeader('X-Stt-Provider-Ms', String(result.providerMs));
      res.setHeader('X-Stt-Language', result.detectedLanguage || result.language || 'unknown');
      res.setHeader('X-Door-Language', decision?.language ?? result.language ?? 'unknown');
      res.setHeader('X-Door-Language-Override', decision?.overridden ? '1' : '0');
      // Voice identity travels in headers too, so a proxy panel can read it
      // without parsing the body.
      res.setHeader('X-Voice-Trace', voiceTraceId);
      res.setHeader('X-Voice-Status', voice?.status ?? 'disabled');
      res.setHeader('X-Voice-Print', voice?.printId ?? 'none');
      res.setHeader('X-Voice-Key', voice?.voiceKey ?? 'none');
      res.setHeader(
        'X-Voice-Similarity',
        voice?.similarity === null || voice?.similarity === undefined
          ? 'none'
          : String(voice.similarity),
      );
      res.setHeader('X-Voice-Ms', voice ? String(voice.ms) : '0');
      res.setHeader('X-Voice-Claim', claimView ? `${claimView.name}:${claimView.status}` : 'none');
      res.status(status).json({
        ...result,
        // Identity + measured acoustics travel WITH the transcript, so the door
        // can show who it thinks spoke without a second round trip.
        identity,
        acoustic,
        voiceKey: voiceKey ?? null,
        // `language` is what the door will ANSWER in (and what /turn gets).
        // `detectedLanguage` / `detectedTurnLanguage` keep the raw provider
        // verdict visible, so a disagreement is auditable from the page.
        language: decision ? decision.language : result.language,
        detectedTurnLanguage: decision ? decision.detectedTurnLanguage : null,
        languageDecision: decision,
        sttMs,
        requestedLanguage: language,
        room,
        // Who this voice is — computed from the same bytes, never an extra
        // request. `traceId` is the pin a client can hand back to /turn.
        voice: voice
          ? { ...voice, claim: claimView, claimStatus, traceId: voiceTraceId, readyBeforeStt }
          : {
              status: 'disabled' as const,
              reason: 'voice_id_off',
              printId: null,
              voiceKey: null,
              matched: false,
              similarity: null,
              dims: null,
              version: null,
              durationSec: 0,
              voicedSec: 0,
              frames: 0,
              threshold: voiceThreshold,
              ms: 0,
              cpuMs: 0,
              newCluster: false,
              claim: null,
              claimStatus: 'none' as const,
              traceId: voiceTraceId,
              readyBeforeStt: false,
            },
      });
    },
  );

  /**
   * The audio lane. Chunked transfer, flushed headers, upstream abort on close.
   */
  router.post('/stream', async (req: Request, res: Response) => {
    const body = req.body as {
      text?: string;
      language?: string;
      agentId?: string;
      turnId?: string;
      kind?: 'filler' | 'answer';
    };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Missing text' });
      return;
    }
    const turnId = typeof body.turnId === 'string' && body.turnId ? body.turnId : newTurnId();
    const stepKind: 'filler' | 'answer' = body.kind === 'filler' ? 'filler' : 'answer';
    const ref = audioRefFor(turnId, stepKind);
    const language = normalizeManagerLanguage(body.language);

    const abort = new AbortController();

    try {
      const event: TtsStreamEvent = await streamer({
        text,
        agentId: body.agentId || agentId,
        language,
        res,
        signal: abort.signal,
        teePath: join(store.audioDir, ref.replace(/^audio\//, '')),
        extraHeaders: { 'X-Turn-Id': turnId },
      });

      recordAudio(
        {
          turnId,
          kind: stepKind,
          language: event.language || language,
          modelId: event.modelId,
          voiceId: event.voiceId,
          bytes: event.bytes,
          chunks: event.chunks,
          aborted: event.aborted,
          ref,
          timings: {
            upstreamMs: event.upstreamMs,
            firstChunkMs: event.firstChunkMs,
            headersFlushedMs: event.headersFlushedMs,
            audioTotalMs: event.totalMs,
            abortMs: event.abortMs,
          },
        },
        store,
      );
    } catch (err) {
      // Unsupported language -> clean 422 (voice matrix, not a broken stream).
      const anyErr = err as { name?: string; requested?: string; supported?: string[] };
      if (anyErr?.name === 'UnsupportedLanguageError') {
        res.status(422).json({
          error: 'unsupported_language',
          requestedLanguage: anyErr.requested,
          supportedLanguages: anyErr.supported,
        });
        return;
      }
      console.error('[coexistirVoice] stream failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Could not synthesize speech' });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });

  /** The house log rows — the same rows a Hermes profile reads off disk. */
  router.get('/turns', (req: Request, res: Response) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20));
    res.json({ dir: store.dir, turns: readTurns(store, limit) });
  });

  /**
   * Every log row (turns AND audio events), for the verification harness and
   * for a Hermes profile that wants the audio timings next to the text.
   */
  router.get('/events', (req: Request, res: Response) => {
    const limit = Math.min(400, Math.max(1, Number.parseInt(String(req.query.limit ?? '100'), 10) || 100));
    res.json({ dir: store.dir, events: readAllEvents(store, limit) });
  });

  /**
   * WHO the bridge thinks is speaking right now — the voice-ID panel's live read.
   *
   * Awaits a claim read (the panel polls every few seconds, so a Mongo round trip
   * is fine here; the turn path never waits on this). Returns the same record the
   * turn row stores, including the honest gaps: `biometric:false`,
   * `confidence:null`, `source:'voiceKey+name-claims'`.
   */
  router.get('/identity', async (req: Request, res: Response) => {
    const voiceKey = typeof req.query.voiceKey === 'string' ? req.query.voiceKey.trim() : '';
    if (!voiceKey) {
      res.status(400).json({ error: 'voiceKey is required', identity: null });
      return;
    }
    const identity = await identityPort.ensure(voiceKey);
    res.json({ identity });
  });

  /** Hard questions with no Hermes answer yet. */
  router.get('/consult/pending', (_req: Request, res: Response) => {
    const pending = pendingConsults(store);
    res.json({ dir: store.dir, count: pending.length, pending });
  });

  // --- voice identity, for the debug panel --------------------------------
  //
  // Data only: the panel owns every pixel. Three reads, all behind the same
  // `?debug=1` gate the door itself uses for the rail.
  //
  //   GET /voice/id/latest   the live observation for a room + threshold
  //   GET /voice/id/events   the append-only fingerprint rows (disk)
  //   GET /voice/id/stream   SSE: observed / claim / attached, as they happen

  /** The newest observation, plus what this process knows (no disk read). */
  router.get('/id/latest', (req: Request, res: Response) => {
    if (!voiceDebugOpen(req)) {
      res.status(403).json({ error: 'debug_only', hint: 'add ?debug=1' });
      return;
    }
    const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : 'coexistir';
    const latest = bus.latest(room);
    res.json({
      ok: true,
      enabled: voiceIdEnabled,
      room,
      threshold: voiceThreshold,
      dims: VOICEPRINT_DIMS,
      enrolled: registry.list().map((print) => ({
        printId: print.printId,
        voiceKey: print.voiceKey,
        enrolledAt: print.enrolledAt,
        source: print.source ?? null,
      })),
      sessionPrints: registry.sessionPrints(),
      latest,
      events: bus.eventLog(5),
    });
  });

  /** The fingerprint timeline (append-only rows, claims included). */
  router.get('/id/events', (req: Request, res: Response) => {
    if (!voiceDebugOpen(req)) {
      res.status(403).json({ error: 'debug_only', hint: 'add ?debug=1' });
      return;
    }
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
    res.json({ ok: true, dir: store.voiceIdFile, threshold: voiceThreshold, rows: readVoiceIdRows(store, limit) });
  });

  /**
   * The push channel. One SSE event per observation, per resolved claim and per
   * turn attachment, so the rail can show the claim land without polling.
   * `?debug=1` is required; the door's public mode never opens this stream.
   */
  router.get('/id/stream', (req: Request, res: Response) => {
    if (!voiceDebugOpen(req)) {
      res.status(403).json({ error: 'debug_only', hint: 'add ?debug=1' });
      return;
    }
    const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : '';
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');

    const send = (event: VoiceIdEvent) => {
      if (room && event.room !== room) return;
      if (res.writableEnded) return;
      res.write(`event: voice-id\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Backlog first, so a panel opened mid-session is not blank.
    res.write(`: voice-id ready dims=${VOICEPRINT_DIMS} threshold=${voiceThreshold}\n\n`);
    for (const event of bus.eventLog(20)) send(event);

    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
    }, 15_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- speak-to-enroll ------------------------------------------------------
  //
  // Binding a name to a voice, BY VOICE. A supervised flow at the kiosk: the
  // owner speaks a prompted phrase 2–3 times, the server averages the prints
  // and persists one enrolled print under `person:<name>`, then files the
  // name verified (reason 'enrollment'). From then on the ear matches the
  // VOICE first and the name rides the match — an unenrolled voice resolves
  // no claim and stays `unknown`, even when a name was once typed.
  //
  // Like claim filing, these endpoints are public: enrollment is a physical
  // act (the supervisor stands at the kiosk with the owner), and every step
  // records who supervised it. `POST /stt` stays the only path that feeds
  // the turn; enrollment clips never enter the bus, the turns or the consult
  // queue — they cannot lend a voice to anyone's question.

  const enrollStore = deps.enrollStore ?? new EnrollmentStore();
  const fileEnrollClaim =
    deps.fileEnrollClaimImpl ??
    (async (entry: {
      voiceKey: string;
      claimedName: string;
      normalizedName: string;
      claimBy: string;
      printId: string;
      consistency: number;
      clips: number;
    }): Promise<void> => {
      const db = await getWeaverDb();
      const now = new Date().toISOString();
      await db.collection('voice_name_claims').insertOne({
        voiceKey: entry.voiceKey,
        claimedName: entry.claimedName,
        normalizedName: entry.normalizedName,
        claimBy: entry.claimBy,
        claimAt: now,
        status: 'verified',
        verifiedAt: now,
        verifiedBy: entry.claimBy,
        verifyReason: 'enrollment',
        printId: entry.printId,
        enrollConsistency: entry.consistency,
        enrollClips: entry.clips,
      } as never);
      // Best-effort mirror into the person's own thread (the one path that
      // may open a named thread). A mirror failure never fails the binding.
      try {
        const { defaultKnowledgePort } = await import('../modules/knowledge/defaultKnowledgePort');
        const port = defaultKnowledgePort();
        await port.addMemory(knowledgeGroupForVoiceKey(entry.voiceKey), {
          name: `enrollment:${entry.voiceKey}:${entry.printId}`,
          content:
            `[ENROLLED] Voice ${entry.voiceKey} was bound to "${entry.claimedName}" ` +
            `by ${entry.claimBy} at ${now} (${entry.clips} clips, consistency ${entry.consistency}). ` +
            'The name is a label on this voice match, not a free claim.',
          source: 'speak-to-enroll',
          sourceDescription: 'Castalia door speak-to-enroll binding',
          metadata: {
            voiceKey: entry.voiceKey,
            claimedName: entry.claimedName,
            claimBy: entry.claimBy,
            printId: entry.printId,
            status: 'verified',
          },
        });
      } catch (err) {
        console.warn('[coexistirVoice] enrollment mirror failed (binding kept):', (err as Error)?.message);
      }
    });

  function publicEnrollment(session: EnrollmentSession) {
    return {
      enrollmentId: session.id,
      voiceKey: session.voiceKey,
      name: session.name,
      supervisedBy: session.supervisedBy,
      prompt: session.prompt,
      needClips: session.needClips,
      clips: session.clips.map((clip) => ({
        take: clip.take,
        dims: clip.dims,
        durationSec: clip.durationSec,
        voicedSec: clip.voicedSec,
        f0Hz: clip.f0Hz,
        at: clip.at,
      })),
      consistency: session.consistency,
    };
  }

  /** Begin a supervised binding: who, watched by whom. */
  router.post('/id/enroll/start', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: unknown; supervisedBy?: unknown; promptIndex?: unknown };
    const promptIndex =
      typeof body.promptIndex === 'number' && Number.isFinite(body.promptIndex)
        ? Math.max(0, Math.min(ENROLL_PROMPTS.length - 1, Math.floor(body.promptIndex)))
        : 0;
    const started = enrollStore.start({
      name: typeof body.name === 'string' ? body.name : '',
      supervisedBy: typeof body.supervisedBy === 'string' ? body.supervisedBy : '',
      promptIndex,
    });
    if ('failure' in started) {
      const status = started.failure === 'name_required' || started.failure === 'supervisor_required' ? 400 : 422;
      res.status(status).json({ ok: false, error: started.failure, detail: started.detail ?? null });
      return;
    }
    res.status(201).json({ ok: true, ...publicEnrollment(started.session) });
  });

  /** Progress probe for the panel (cheap, no audio). */
  router.get('/id/enroll/status', (req: Request, res: Response) => {
    const id = typeof req.query.enrollmentId === 'string' ? req.query.enrollmentId : '';
    const session = id ? enrollStore.peek(id) : null;
    if (!session) {
      res.status(404).json({ ok: false, error: 'unknown_session' });
      return;
    }
    res.json({ ok: true, ...publicEnrollment(session) });
  });

  /**
   * One spoken sample. Raw body like `/stt` (the recorder Blob straight in),
   * `?enrollmentId=` on the query — the same WAV the ear fingerprints.
   */
  router.post(
    '/id/enroll/clip',
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }),
    (req: Request, res: Response) => {
      const id = typeof req.query.enrollmentId === 'string' ? req.query.enrollmentId : '';
      if (!id) {
        res.status(400).json({ ok: false, error: 'enrollmentId is required' });
        return;
      }
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (audio.length === 0) {
        res.status(400).json({ ok: false, error: 'missing_audio' });
        return;
      }
      const mimetype = String(req.headers['content-type'] || 'audio/wav').split(';')[0].trim();
      const added = enrollStore.addClip(id, audio, mimetype);
      if ('failure' in added) {
        const status = added.failure === 'unknown_session' || added.failure === 'session_expired' ? 404 : 422;
        res.status(status).json({ ok: false, error: added.failure, detail: added.detail ?? null });
        return;
      }
      res.status(201).json({
        ok: true,
        ...publicEnrollment(added.session),
        take: added.clip.take,
        voicedSec: added.clip.voicedSec,
        durationSec: added.clip.durationSec,
        f0Hz: added.clip.f0Hz,
      });
    },
  );

  /**
   * Bind it: average the clips, persist the print under `person:<name>`,
   * file the name verified (reason 'enrollment'). Refuses sets that are too
   * few or do not sound like one voice — an interrupted or muddy session
   * binds nothing.
   */
  router.post('/id/enroll/finish', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { enrollmentId?: unknown };
    const id = typeof body.enrollmentId === 'string' ? body.enrollmentId : '';
    if (!id) {
      res.status(400).json({ ok: false, error: 'enrollmentId is required' });
      return;
    }
    const done = enrollStore.finish(id, registry);
    if ('failure' in done) {
      const status = done.failure === 'unknown_session' || done.failure === 'session_expired' ? 404 : 422;
      res.status(status).json({
        ok: false,
        error: done.failure,
        detail: done.detail ?? null,
        consistency: done.consistency ?? null,
      });
      return;
    }
    try {
      await fileEnrollClaim({
        voiceKey: done.voiceKey,
        claimedName: done.session.name,
        normalizedName: done.session.normalizedName,
        claimBy: done.session.supervisedBy,
        printId: done.printId,
        consistency: done.consistency,
        clips: done.clips,
      });
    } catch (err) {
      // The print is persisted but the name is not bound: say so loudly, so
      // the panel never shows a half-binding as a person.
      console.error('[coexistirVoice] enrollment claim failed:', err);
      res.status(500).json({
        ok: false,
        error: 'claim_failed',
        detail: `voiceprint kept under ${done.voiceKey} but the name was not filed — file a claim for that key`,
        printId: done.printId,
        voiceKey: done.voiceKey,
      });
      return;
    }
    // The next turn reads this key warm instead of pending.
    void identityPort.refresh(done.voiceKey).catch(() => undefined);
    // Prime the ear's own claim cache too: the next observation resolves its
    // name from memory instead of racing the store behind the turn.
    claimCache.set(done.voiceKey, {
      claim: { name: done.session.name, status: 'verified' },
      at: Date.now(),
    });
    res.status(201).json({
      ok: true,
      printId: done.printId,
      voiceKey: done.voiceKey,
      name: done.session.name,
      status: 'verified',
      verifyReason: 'enrollment',
      verifiedBy: done.session.supervisedBy,
      clips: done.clips,
      consistency: done.consistency,
      threshold: voiceThreshold,
      enrolledAt: done.enrolledAt,
      claimBy: done.session.supervisedBy,
      normalizedName: normalizeClaimName(done.session.name),
    });
  });

  /**
   * Re-speak check: a fresh clip against the enrolled print for `?voiceKey=`.
   * The panel runs this right after binding (proof the door knows the voice)
   * and the owner can re-run it any time. Same threshold as the ear.
   */
  router.post(
    '/id/enroll/verify',
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }),
    (req: Request, res: Response) => {
      const voiceKey = typeof req.query.voiceKey === 'string' ? req.query.voiceKey.trim() : '';
      if (!voiceKey) {
        res.status(400).json({ ok: false, error: 'voiceKey is required' });
        return;
      }
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (audio.length === 0) {
        res.status(400).json({ ok: false, error: 'missing_audio' });
        return;
      }
      const enrolled = registry.list().find((print) => print.voiceKey === voiceKey) ?? null;
      const mimetype = String(req.headers['content-type'] || 'audio/wav').split(';')[0].trim();
      const result = verifyAgainst(audio, mimetype, enrolled, voiceThreshold);
      if (result.failure === 'unknown_session') {
        res.status(404).json({ ok: false, error: 'not_enrolled', detail: result.detail, voiceKey });
        return;
      }
      if (result.failure) {
        res.status(422).json({ ok: false, error: result.failure, voiceKey });
        return;
      }
      res.json({ ok: true, ...result });
    },
  );

  /**
   * Where Hermes (a cron job or a profile with file access) writes its answer.
   * Append-only; the room picks the answer up from the log on the next review.
   */
  router.post('/consult/answer', (req: Request, res: Response) => {
    const body = req.body as { turnId?: string; answer?: string; answeredBy?: string; language?: string };
    const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : '';
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!turnId || !answer) {
      res.status(400).json({ error: 'turnId and answer are required' });
      return;
    }
    const row = answerConsult(
      {
        turnId,
        answer,
        answeredBy: body.answeredBy || 'hermes',
        language: body.language ?? 'pt',
      },
      store,
    );
    res.json({ ok: true, row, pending: pendingConsults(store).length });
  });

  /** Where the log lives + how much is in it (proof the seam is wired). */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      agentId,
      reflexModel: REFLEX_MODEL,
      house: houseInventory(store),
      pendingConsults: pendingConsults(store).length,
      // The panel's "is identity even on?" probe, without opening the id API.
      voiceId: {
        enabled: voiceIdEnabled,
        dims: VOICEPRINT_DIMS,
        threshold: voiceThreshold,
        enrolled: registry.list().length,
        attachWindowMs: bus.attachWindowMs,
        debugOpen: Boolean(deps.voiceDebug),
      },
    });
  });

  /**
   * The streaming ear's capability card. The door reads this before it opens a
   * socket: `available: false` (no key configured) keeps the batch ear, and the
   * endpointing numbers here are the ones the socket will actually use, so the
   * debug rail cannot disagree with the server about where a turn ends.
   */
  router.get('/stt-stream', (_req: Request, res: Response) => {
    sttStreamInfo((body) =>
      res.status(200).json({ ...body, batchFallback: '/api/coexistir/voice/stt' }),
    );
  });

  return router;
}

export default createCoexistirVoiceRouter();
