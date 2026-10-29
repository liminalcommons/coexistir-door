/**
 * enrollment — speak-to-enroll: bind a typed name to a voice, by voice.
 *
 * A typed name claim alone never identifies anyone (see
 * `modules/naming/voiceClaimPolicy.ts`): the kiosk key `owl:front-door` is the
 * door's key, shared by every visitor, so a name sitting on it is a rumour,
 * not a recognition. Enrollment is the voice half that fixes that:
 *
 *   1. the owner speaks a prompted phrase 2–3 times (`start` + `clip`),
 *   2. the server fingerprints each clip with the same 52-dim pipeline the ear
 *      uses (`computeFingerprint`), refuses clips that are too short, silent
 *      or unreadable, and refuses sets that do not sound like ONE voice
 *      (pairwise consistency floor),
 *   3. `finish` averages the clip vectors, L2-normalises, and persists ONE
 *      enrolled print via `VoiceprintRegistry.enroll` under a person-scoped
 *      key `person:<normalized-name>` — never under the kiosk key,
 *   4. `verify` re-speaks: a fresh clip must match the enrolled print at or
 *      above the identity threshold (default 0.82, the registry's own bar).
 *
 * After that the door's existing rule does the rest, unchanged: a turn is
 * `identified` only when an enrolled print matches AND a claim resolves for
 * the matched key (`turnVoiceFrom`). A stranger matches nothing, resolves no
 * claim, and stays `unknown` — even when a name was once typed somewhere.
 *
 * Supervision: enrollment is a physical act at the kiosk (the claimant stands
 * next to the owner). `supervisedBy` is recorded on the session, the print
 * (`source: 'enroll:<session>'`) and the verified claim row
 * (`verifyReason: 'enrollment'`), so any binding can be audited back to who
 * watched it happen. Sessions are in-memory with a TTL and never touch disk.
 */

import {
  computeFingerprint,
  cosineSimilarity,
  decodeWav,
  printIdFor,
  VOICEPRINT_DIMS,
  DEFAULT_MATCH_THRESHOLD,
  type VoiceprintRegistry,
} from './voiceIdentity';
import { normalizeClaimName } from '../naming/voiceClaimPolicy';

/** How many spoken samples a binding needs (the owner speaks 2–3 times). */
export const ENROLL_MIN_CLIPS = 2;
export const ENROLL_MAX_CLIPS = 3;

/**
 * Two clips of one voice must clear this to belong to the same set. Below the
 * 0.82 identity bar on purpose: one sitting varies (distance, a cold), and
 * the re-speak verification — not this gate — is what confirms the binding.
 */
export const ENROLL_CONSISTENCY_FLOOR = 0.7;

/** Sessions die this fast: an interrupted enrollment leaves nothing behind. */
export const ENROLL_SESSION_TTL_MS = 10 * 60 * 1000;
const ENROLL_MAX_SESSIONS = 16;

/**
 * The prompted phrases. Short, read naturally, PT-first — the door is a
 * Portuguese kiosk. A phrase is a speaking prompt, not a passphrase: the print
 * is text-independent statistics, so WHAT is said matters less than THAT one
 * voice said all of it.
 */
export const ENROLL_PROMPTS: ReadonlyArray<{ text: string; lang: 'pt' | 'en' }> = [
  { text: 'A casa está em ordem', lang: 'pt' },
  { text: 'Sou eu, cheguei agora', lang: 'pt' },
  { text: 'Boa noite, casa', lang: 'pt' },
];

export type EnrollmentFailure =
  | 'name_required'
  | 'supervisor_required'
  | 'name_rejected'
  | 'unknown_session'
  | 'session_expired'
  | 'too_many_clips'
  | 'no_audio'
  | 'unsupported_container'
  | 'too_short'
  | 'silent'
  | 'too_few_clips'
  | 'inconsistent_voice';

export interface EnrollClip {
  take: number;
  dims: number;
  durationSec: number;
  voicedSec: number;
  f0Hz: number;
  vector: number[];
  at: string;
}

export interface EnrollmentSession {
  id: string;
  /** `person:<normalized-name>` — the key the print and the claim share. */
  voiceKey: string;
  name: string;
  normalizedName: string;
  supervisedBy: string;
  prompt: { text: string; lang: 'pt' | 'en' };
  needClips: number;
  clips: EnrollClip[];
  /** Min pairwise cosine once ≥2 clips exist, else null. */
  consistency: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnrollmentStoreOptions {
  now?: () => number;
  newId?: () => string;
}

function newSessionId(newId?: () => string): string {
  if (newId) return newId();
  const rand = Math.random().toString(36).slice(2, 8);
  return `enr_${Date.now().toString(36)}_${rand}`;
}

/** Person-scoped identity key. `guest` is never a voice — refuse it as a name. */
export function personKeyFor(name: string): string | null {
  const normalized = normalizeClaimName(name);
  if (!normalized || normalized === 'guest') return null;
  return `person:${normalized}`;
}

/** Min pairwise cosine across a set of vectors (null when <2 vectors). */
export function minPairwiseSimilarity(vectors: number[][]): number | null {
  if (vectors.length < 2) return null;
  let min = 1;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim < min) min = sim;
    }
  }
  return Math.round(min * 10000) / 10000;
}

function averageVectors(vectors: number[][]): number[] {
  const dims = vectors[0].length;
  const mean = new Array<number>(dims).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) mean[i] += vector[i] / vectors.length;
  }
  let norm = 0;
  for (const value of mean) norm += value * value;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return mean;
  return mean.map((value) => value / norm);
}

function fingerprintVector(
  audio: Buffer,
  mimetype: string,
): { vector: EnrollClip; failure: null } | { vector: null; failure: 'no_audio' | 'unsupported_container' | 'too_short' | 'silent' } {
  const decoded = decodeWav(audio);
  if (!decoded) {
    const isWav = /wav|wave|x-wav/i.test(mimetype ?? '');
    return { vector: null, failure: isWav ? 'no_audio' : 'unsupported_container' };
  }
  const result = computeFingerprint(decoded);
  if (!result.ok || !result.fingerprint) {
    const reason = result.reason ?? 'no_audio';
    if (reason === 'too_short') return { vector: null, failure: 'too_short' };
    if (reason === 'silent') return { vector: null, failure: 'silent' };
    return { vector: null, failure: 'no_audio' };
  }
  const fp = result.fingerprint;
  return {
    vector: {
      take: 0,
      dims: fp.dims,
      durationSec: Math.round(fp.durationSec * 1000) / 1000,
      voicedSec: Math.round(fp.voicedSec * 1000) / 1000,
      f0Hz: fp.f0Hz,
      vector: fp.vector,
      at: new Date().toISOString(),
    },
    failure: null,
  };
}

export class EnrollmentStore {
  private readonly now: () => number;
  private readonly newId: () => string;
  private sessions = new Map<string, { session: EnrollmentSession; expiresAt: number }>();

  constructor(options: EnrollmentStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => newSessionId());
  }

  start(args: {
    name: string;
    supervisedBy: string;
    promptIndex?: number;
  }): { session: EnrollmentSession } | { failure: EnrollmentFailure; detail?: string } {
    const name = (args.name ?? '').trim();
    if (!name) return { failure: 'name_required' };
    const supervisedBy = (args.supervisedBy ?? '').trim();
    if (!supervisedBy) return { failure: 'supervisor_required' };
    const voiceKey = personKeyFor(name);
    if (!voiceKey) return { failure: 'name_rejected', detail: 'that name cannot be a voice key' };
    this.prune();
    if (this.sessions.size >= ENROLL_MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const prompt = ENROLL_PROMPTS[args.promptIndex ?? 0] ?? ENROLL_PROMPTS[0];
    const at = new Date(this.now()).toISOString();
    const session: EnrollmentSession = {
      id: this.newId(),
      voiceKey,
      name,
      normalizedName: normalizeClaimName(name),
      supervisedBy,
      prompt: { ...prompt },
      needClips: ENROLL_MAX_CLIPS,
      clips: [],
      consistency: null,
      createdAt: at,
      updatedAt: at,
    };
    this.sessions.set(session.id, { session, expiresAt: this.now() + ENROLL_SESSION_TTL_MS });
    return { session };
  }

  /** Live session or null (unknown/expired ids read the same: gone). */
  peek(id: string): EnrollmentSession | null {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    if (this.now() > entry.expiresAt) {
      this.sessions.delete(id);
      return null;
    }
    return entry.session;
  }

  addClip(
    id: string,
    audio: Buffer,
    mimetype: string,
  ): { session: EnrollmentSession; clip: EnrollClip } | { failure: EnrollmentFailure; detail?: string } {
    const entry = this.sessions.get(id);
    if (!entry) return { failure: 'unknown_session' };
    if (this.now() > entry.expiresAt) {
      this.sessions.delete(id);
      return { failure: 'session_expired' };
    }
    const session = entry.session;
    if (session.clips.length >= ENROLL_MAX_CLIPS) return { failure: 'too_many_clips' };
    const fingerprinted = fingerprintVector(audio, mimetype);
    if (!fingerprinted.vector) return { failure: fingerprinted.failure };
    const clip: EnrollClip = { ...fingerprinted.vector, take: session.clips.length + 1 };
    session.clips.push(clip);
    session.consistency = minPairwiseSimilarity(session.clips.map((c) => c.vector));
    session.updatedAt = new Date(this.now()).toISOString();
    return { session, clip };
  }

  finish(
    id: string,
    registry: VoiceprintRegistry,
  ):
    | {
        session: EnrollmentSession;
        printId: string;
        voiceKey: string;
        clips: number;
        consistency: number;
        enrolledAt: string;
      }
    | { failure: EnrollmentFailure; detail?: string; consistency?: number | null } {
    const entry = this.sessions.get(id);
    if (!entry) return { failure: 'unknown_session' };
    if (this.now() > entry.expiresAt) {
      this.sessions.delete(id);
      return { failure: 'session_expired' };
    }
    const session = entry.session;
    if (session.clips.length < ENROLL_MIN_CLIPS) {
      return { failure: 'too_few_clips', detail: `need ${ENROLL_MIN_CLIPS}, have ${session.clips.length}` };
    }
    const consistency = minPairwiseSimilarity(session.clips.map((c) => c.vector)) ?? 1;
    if (consistency < ENROLL_CONSISTENCY_FLOOR) {
      return {
        failure: 'inconsistent_voice',
        detail: `clips disagree (${consistency} < ${ENROLL_CONSISTENCY_FLOOR}): same voice, same room, try again`,
        consistency,
      };
    }
    const averaged = averageVectors(session.clips.map((c) => c.vector));
    if (averaged.length !== VOICEPRINT_DIMS) {
      return { failure: 'no_audio', detail: 'averaged print has wrong dims' };
    }
    const print = registry.enroll({
      voiceKey: session.voiceKey,
      vector: averaged,
      printId: printIdFor(averaged),
      source: `enroll:${session.id}`,
    });
    session.updatedAt = new Date(this.now()).toISOString();
    this.sessions.delete(id);
    return {
      session,
      printId: print.printId,
      voiceKey: print.voiceKey,
      clips: session.clips.length,
      consistency,
      enrolledAt: print.enrolledAt,
    };
  }

  /** Drop one session (the panel's cancel button). */
  discard(id: string): boolean {
    return this.sessions.delete(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.sessions) {
      if (now > entry.expiresAt) this.sessions.delete(id);
    }
  }
}

export interface VerifyResult {
  match: boolean;
  similarity: number | null;
  threshold: number;
  voiceKey: string;
  printId: string | null;
  voicedSec: number;
  failure: EnrollmentFailure | null;
  detail?: string;
}

/**
 * Re-speak check: a fresh clip must match the enrolled print for `voiceKey`
 * at or above `threshold` (the registry's own identity bar, default 0.82).
 * The enrolled vector is read from the registry so the route — which owns the
 * registry — stays the only thing that touches disk.
 */
export function verifyAgainst(
  audio: Buffer,
  mimetype: string,
  enrolled: { printId: string; voiceKey: string; vector: number[] } | null,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): VerifyResult {
  if (!enrolled) {
    return {
      match: false,
      similarity: null,
      threshold,
      voiceKey: '',
      printId: null,
      voicedSec: 0,
      failure: 'unknown_session',
      detail: 'no enrolled print for this voice',
    };
  }
  const fingerprinted = fingerprintVector(audio, mimetype);
  if (!fingerprinted.vector) {
    return {
      match: false,
      similarity: null,
      threshold,
      voiceKey: enrolled.voiceKey,
      printId: enrolled.printId,
      voicedSec: 0,
      failure: fingerprinted.failure,
    };
  }
  const similarity = Math.round(cosineSimilarity(fingerprinted.vector.vector, enrolled.vector) * 10000) / 10000;
  return {
    match: similarity >= threshold,
    similarity,
    threshold,
    voiceKey: enrolled.voiceKey,
    printId: enrolled.printId,
    voicedSec: fingerprinted.vector.voicedSec,
    failure: null,
  };
}
