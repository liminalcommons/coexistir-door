/**
 * voiceIdentity — what the bridge ACTUALLY knows about who is speaking, and
 * nothing more.
 *
 * The owner's debug panel was showing a kiosk-wide claim ("owl:front-door")
 * pinned above every turn while the turn rows themselves carried
 * `speaker: null` — so the panel answered "who is this?" with a fact about the
 * DOOR, not about the turn. This module is the honest middle:
 *
 *   - identity is keyed on `voiceKey` (owl cluster / livekit identity / a
 *     `person:<name>` key bound by speak-to-enroll). That is a claim, not a
 *     person: the same key is whatever voice the tile was opened with, and
 *     the front door pins one key for everybody who walks up to it.
 *   - the NAME comes from `voice_name_claims` (the community claim rows), with
 *     the claim state (none / unverified / verified) and the quorum counts.
 *   - there is no speaker match IN THIS MODULE: `biometric` is always false
 *     and `confidence` always null here. The voice half lives beside it —
 *     `modules/voice/voiceIdentity.ts` fingerprints clips, `voiceIdBus`
 *     carries the observation to the turn, and `turnVoiceFrom` reports
 *     `identified` only when an enrolled print matched AND a claim resolved.
 *     This module reads claims; it never invents a voice match.
 *
 * Why a cache: `/turn` must not pay a Mongo round trip on the visitor's critical
 * path (the measured budget is ~105–125 ms for the whole turn). The route kicks
 * a refresh in the background when a turn starts and reads whatever is warm by
 * the time the row is written. A cold start is reported as `pending`, not as
 * "no claim" — because "I have not looked yet" and "there is nothing there" are
 * different facts, and the panel must not conflate them.
 */

import { getWeaverDb } from '../../database/weaverDb';

export type ClaimState = 'none' | 'unverified' | 'verified';
export type IdentityState = 'resolved' | 'pending' | 'error';

export interface VoiceIdentity {
  voiceKey: string;
  /** The claimed name, when one exists. */
  name: string | null;
  /** none = no rows, unverified = rows but no quorum/steward, verified = quorum/steward. */
  claim: ClaimState;
  /** Total claim rows for this key (quorum denominator is 2 — see policy). */
  claims: number;
  /** Rows with status 'verified'. */
  verified: number;
  /** A biometric/voiceprint match backed this? Always false: none is computed. */
  biometric: false;
  /** Speaker-ID confidence: ALWAYS null (no embedding stage exists). */
  confidence: null;
  /** Where the identity came from, in the panel's words. */
  source: 'voiceKey+name-claims';
  state: IdentityState;
  /** ISO time the claim snapshot was read, null when nothing is cached. */
  resolvedAt: string | null;
  /** Last read error, if the claims store could not answer. */
  error?: string;
}

const COLLECTION = 'voice_name_claims';
/** A claim snapshot older than this is refreshed on the next turn. */
const TTL_MS = 30_000;

interface CacheEntry {
  identity: VoiceIdentity;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<VoiceIdentity | null>>();

function emptyIdentity(voiceKey: string): VoiceIdentity {
  return {
    voiceKey,
    name: null,
    claim: 'none',
    claims: 0,
    verified: 0,
    biometric: false,
    confidence: null,
    source: 'voiceKey+name-claims',
    state: 'pending',
    resolvedAt: null,
  };
}

/**
 * Read the claim rows for one voice key. Best-effort: a store failure returns a
 * `state:'error'` identity instead of throwing into the turn path.
 */
export async function readIdentity(voiceKey: string): Promise<VoiceIdentity> {
  const key = typeof voiceKey === 'string' ? voiceKey.trim() : '';
  if (!key) {
    return {
      ...emptyIdentity(''),
      claim: 'none',
      state: 'error',
      error: 'no voiceKey on this turn',
    };
  }
  try {
    const db = await getWeaverDb();
    const rows = await db
      .collection(COLLECTION)
      .find({ voiceKey: key })
      .sort({ claimAt: -1 })
      .toArray();
    const verifiedRows = rows.filter((r) => r.status === 'verified');
    const named = verifiedRows[0] ?? rows[0];
    const name = named && typeof named.claimedName === 'string' ? named.claimedName : null;
    return {
      voiceKey: key,
      name,
      claim: verifiedRows.length > 0 ? 'verified' : rows.length > 0 ? 'unverified' : 'none',
      claims: rows.length,
      verified: verifiedRows.length,
      biometric: false,
      confidence: null,
      source: 'voiceKey+name-claims',
      state: 'resolved',
      resolvedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ...emptyIdentity(key),
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Refresh the cache for one voice key. Single-flight and non-blocking by design:
 * the caller does `void refreshIdentity(key)` and reads `peekIdentity(key)` when
 * it needs a value. Never rejects.
 */
export function refreshIdentity(voiceKey: string): Promise<VoiceIdentity | null> {
  const key = typeof voiceKey === 'string' ? voiceKey.trim() : '';
  if (!key) return Promise.resolve(null);
  const running = inflight.get(key);
  if (running) return running;
  const task = readIdentity(key)
    .then((identity) => {
      cache.set(key, { identity, at: Date.now() });
      return identity;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/**
 * The cached identity for a voice key, or a `pending` placeholder. This is what
 * the turn row records: either a real snapshot or an honest "not looked yet".
 */
export function peekIdentity(voiceKey: string): VoiceIdentity {
  const key = typeof voiceKey === 'string' ? voiceKey.trim() : '';
  if (!key) return { ...emptyIdentity(''), state: 'error', error: 'no voiceKey on this turn' };
  const hit = cache.get(key);
  if (!hit) return emptyIdentity(key);
  return hit.identity;
}

/** True when the cached value is still inside the TTL (test/debug helper). */
export function identityIsFresh(voiceKey: string): boolean {
  const hit = cache.get(voiceKey.trim());
  return Boolean(hit && Date.now() - hit.at < TTL_MS);
}

/**
 * Await a fresh identity when a caller CAN afford it (health probes, tests).
 * The turn path never calls this.
 */
export async function ensureIdentity(voiceKey: string): Promise<VoiceIdentity> {
  if (identityIsFresh(voiceKey)) return peekIdentity(voiceKey);
  await refreshIdentity(voiceKey);
  return peekIdentity(voiceKey);
}

/** Test hook: drop the cache so a spec can control every read. */
export function __resetIdentityCache(): void {
  cache.clear();
  inflight.clear();
}
