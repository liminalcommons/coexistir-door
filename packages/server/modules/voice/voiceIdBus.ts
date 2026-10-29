/**
 * voiceIdBus — the short-lived bridge between the ear and the turn.
 *
 * `/voice/stt` and `/voice/turn` are two separate HTTP requests, and the door
 * does not thread an id between them. So the ear leaves its observation here,
 * and the turn — milliseconds later — picks it up:
 *
 *   POST /stt   → fingerprint (already computed during the STT wait)
 *               → bus.put(observation)
 *               → claim resolution lands in the same observation when it does
 *   POST /turn  → bus.attach(room, {traceId?, turnId})
 *               → turn row carries speaker + claim
 *
 * Two rules make this safe:
 *   - an observation is consumed ONCE (a merged/duplicated turn cannot steal
 *     the same voice, and the next visitor's words cannot inherit it);
 *   - it expires (default 20 s), so a question typed long after the last clip
 *     never picks up a stale voice.
 *
 * It is also the push channel the debug panel subscribes to: every observation,
 * every resolved claim and every turn attachment is published as one JSON
 * event (SSE in `coexistirVoiceRoutes`, `GET /voice/id/stream`). Nothing here
 * touches the network or a database.
 */

import type { VoiceFingerprint } from './voiceIdentity';

export type VoiceClaimStatus = 'none' | 'pending' | 'resolved';

/** The name claim attached to a voice, never an identity by itself. */
export interface VoiceClaimView {
  name: string;
  status: 'verified' | 'unverified';
}

export interface VoiceIdObservation {
  traceId: string;
  room: string;
  ts: string;
  /** Epoch ms of the observation (the bus's own clock). */
  at: number;
  status: VoiceFingerprint['status'];
  printId: string | null;
  voiceKey: string | null;
  matched: boolean;
  similarity: number | null;
  dims: number | null;
  durationSec: number;
  voicedSec: number;
  /** Fingerprint CPU time (ms) — overlapped with the STT call, never added. */
  ms: number;
  /** Actual CPU consumed (ms), immune to host load. */
  cpuMs: number;
  threshold: number;
  newCluster: boolean;
  claim: VoiceClaimView | null;
  claimStatus: VoiceClaimStatus;
  /** Set when a turn consumed this observation. */
  turnId: string | null;
  attachedAt: string | null;
}

export type VoiceIdEventName = 'observed' | 'claim' | 'attached';

export interface VoiceIdEvent {
  type: 'voice-id';
  event: VoiceIdEventName;
  ts: string;
  at: number;
  room: string;
  traceId: string;
  turnId: string | null;
  status: VoiceFingerprint['status'];
  printId: string | null;
  voiceKey: string | null;
  matched: boolean;
  similarity: number | null;
  claimStatus: VoiceClaimStatus;
  claim: VoiceClaimView | null;
  /** Claim display name, when the turn attached one. */
  speaker: string | null;
  ms: number | null;
  cpuMs: number | null;
  dims: number | null;
  durationSec: number;
  voicedSec: number;
}

export interface VoiceIdBusOptions {
  /** Observations kept per room (a door has one visitor at a time). */
  perRoom?: number;
  /** Events kept for the SSE backlog. */
  maxEvents?: number;
  /** Attach window: how long an observation stays claimable. */
  maxAgeMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export const DEFAULT_ATTACH_MS = 20_000;

/** `v_<base36 time>_<rand>` — short, sortable, safe in a log line. */
export function newVoiceTraceId(now: number = Date.now()): string {
  return `v_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export class VoiceIdBus {
  private readonly perRoom: number;
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private rooms = new Map<string, VoiceIdObservation[]>();
  private events: VoiceIdEvent[] = [];
  private subscribers = new Set<(event: VoiceIdEvent) => void>();

  constructor(options: VoiceIdBusOptions = {}) {
    this.perRoom = options.perRoom ?? 8;
    this.maxEvents = options.maxEvents ?? 64;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_ATTACH_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message: string) => console.log(message));
  }

  get attachWindowMs(): number {
    return this.maxAgeMs;
  }

  /** Record one ear observation and announce it. */
  put(observation: VoiceIdObservation): VoiceIdObservation {
    const bucket = this.rooms.get(observation.room) ?? [];
    bucket.push(observation);
    while (bucket.length > this.perRoom) bucket.shift();
    this.rooms.set(observation.room, bucket);
    this.pruneRooms();

    this.log(
      `[voice-id] observed room=${observation.room} trace=${observation.traceId} ` +
        `status=${observation.status} print=${observation.printId ?? '—'} ` +
        `matched=${observation.matched ? '1' : '0'} sim=${
          observation.similarity === null ? '—' : observation.similarity.toFixed(3)
        } dims=${observation.dims ?? '—'} ms=${observation.ms.toFixed(1)} ` +
        `voiced=${observation.voicedSec.toFixed(2)}s` +
        (observation.voiceKey ? ` key=${observation.voiceKey}` : '') +
        (observation.newCluster ? ' new-cluster' : ''),
    );
    this.publish(this.eventOf('observed', observation));
    return observation;
  }

  /**
   * Attach a resolved name claim to an observation. Mutates the stored row so a
   * turn that arrives afterwards sees it; publishes the claim event either way.
   */
  setClaim(
    observation: VoiceIdObservation,
    claim: VoiceClaimView | null,
    status: VoiceClaimStatus = claim ? 'resolved' : 'none',
  ): VoiceIdObservation {
    observation.claim = claim;
    observation.claimStatus = status;
    if (claim) {
      this.log(
        `[voice-id] claim ${observation.voiceKey ?? '—'} → "${claim.name}" (${claim.status}) ` +
          `trace=${observation.traceId} sim=${
            observation.similarity === null ? '—' : observation.similarity.toFixed(3)
          }`,
      );
    }
    this.publish(this.eventOf('claim', observation));
    return observation;
  }

  /**
   * Hand the newest unclaimed observation in a room to a turn.
   * `traceId` pins it explicitly (the seam a future client can use); otherwise
   * the freshest one wins, which is exactly the door's stt→turn sequence.
   */
  attach(
    room: string,
    options: { turnId: string; traceId?: string | null; maxAgeMs?: number; now?: number },
  ): VoiceIdObservation | null {
    const bucket = this.rooms.get(room);
    if (!bucket || bucket.length === 0) return null;
    const at = options.now ?? this.now();
    const maxAge = options.maxAgeMs ?? this.maxAgeMs;
    const traceId = typeof options.traceId === 'string' && options.traceId ? options.traceId : null;

    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const candidate = bucket[i];
      if (candidate.turnId) continue;
      if (at - candidate.at > maxAge) continue;
      if (traceId && candidate.traceId !== traceId) continue;
      candidate.turnId = options.turnId;
      candidate.attachedAt = new Date(at).toISOString();
      this.log(
        `[voice-id] attached turn=${options.turnId} trace=${candidate.traceId} ` +
          `print=${candidate.printId ?? '—'} ageMs=${Math.max(0, Math.round(at - candidate.at))} ` +
          `speaker=${candidate.claim?.name ?? 'null'} claim=${candidate.claim?.status ?? 'none'}`,
      );
      this.publish(this.eventOf('attached', candidate));
      return candidate;
    }
    return null;
  }

  /** Newest observation for a room (debug panel polling, no SSE needed). */
  latest(room = 'coexistir'): VoiceIdObservation | null {
    const bucket = this.rooms.get(room);
    return bucket && bucket.length > 0 ? bucket[bucket.length - 1] : null;
  }

  /** Recent observations, oldest first (panel snapshot / SSE hello). */
  recent(room?: string, limit = 20): VoiceIdObservation[] {
    if (room) {
      const bucket = this.rooms.get(room) ?? [];
      return bucket.slice(Math.max(0, bucket.length - limit));
    }
    const all = [...this.rooms.values()].flat().sort((a, b) => a.at - b.at);
    return all.slice(Math.max(0, all.length - limit));
  }

  /** Recent events, oldest first. A new SSE client gets these as its backlog. */
  eventLog(limit = 20): VoiceIdEvent[] {
    return this.events.slice(Math.max(0, this.events.length - limit));
  }

  subscribe(listener: (event: VoiceIdEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Keep the room map bounded: a long-lived process should not accumulate a
   * room per kiosk URL forever. A room with nothing fresh is dropped.
   */
  private pruneRooms(): void {
    if (this.rooms.size <= 4) return;
    const now = this.now();
    for (const [room, bucket] of this.rooms) {
      const newest = bucket[bucket.length - 1];
      if (!newest || now - newest.at > this.maxAgeMs * 3) this.rooms.delete(room);
    }
  }

  private eventOf(name: VoiceIdEventName, observation: VoiceIdObservation): VoiceIdEvent {
    return {
      type: 'voice-id',
      event: name,
      ts: observation.ts,
      at: observation.at,
      room: observation.room,
      traceId: observation.traceId,
      turnId: observation.turnId,
      status: observation.status,
      printId: observation.printId,
      voiceKey: observation.voiceKey,
      matched: observation.matched,
      similarity: observation.similarity,
      claimStatus: observation.claimStatus,
      claim: observation.claim,
      speaker: observation.claim?.name ?? null,
      ms: observation.ms,
      cpuMs: observation.cpuMs,
      dims: observation.dims,
      durationSec: observation.durationSec,
      voicedSec: observation.voicedSec,
    };
  }

  private publish(event: VoiceIdEvent): void {
    this.events.push(event);
    while (this.events.length > this.maxEvents) this.events.shift();
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch (err) {
        this.log(`[voice-id] subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** One bus per process: the ear and the turn share it by construction. */
export const voiceIdBus = new VoiceIdBus();

/** Build an observation from a fingerprint (claim filled in later). */
export function observationFrom(args: {
  fingerprint: VoiceFingerprint;
  room: string;
  traceId: string;
  now: number;
}): VoiceIdObservation {
  return {
    traceId: args.traceId,
    room: args.room,
    ts: new Date(args.now).toISOString(),
    at: args.now,
    status: args.fingerprint.status,
    printId: args.fingerprint.printId,
    voiceKey: args.fingerprint.voiceKey,
    matched: args.fingerprint.matched,
    similarity: args.fingerprint.similarity,
    dims: args.fingerprint.dims,
    durationSec: args.fingerprint.durationSec,
    voicedSec: args.fingerprint.voicedSec,
    ms: args.fingerprint.ms,
    cpuMs: args.fingerprint.cpuMs,
    threshold: args.fingerprint.threshold,
    newCluster: args.fingerprint.newCluster,
    claim: null,
    claimStatus: args.fingerprint.voiceKey ? 'pending' : 'none',
    turnId: null,
    attachedAt: null,
  };
}
