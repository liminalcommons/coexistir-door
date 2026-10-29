/**
 * pinUtils — pure helpers for the meeting tile PIN/FOCUS feature.
 *
 * Pinning is keyed by LiveKit `identity` (stable across layout changes and
 * track re-publishes; `sid` is not — it changes on rejoin). The pinned tile
 * is resolved against the CURRENT participant list on every render, so it
 * follows the participant across layout changes automatically.
 */

export function togglePinnedIdentity(
  current: string | null,
  identity: string,
): string | null {
  if (!identity) return current;
  return current === identity ? null : identity;
}

export function resolvePinnedIdentity<T extends { identity: string }>(
  participants: readonly T[],
  pinnedIdentity: string | null,
): T | null {
  if (!pinnedIdentity) return null;
  return participants.find((p) => p.identity === pinnedIdentity) ?? null;
}

/** True when the pinned participant is gone (left the zone) → caller unpins. */
export function isPinnedParticipantGone<T extends { identity: string }>(
  participants: readonly T[],
  pinnedIdentity: string | null,
): boolean {
  return pinnedIdentity !== null && !participants.some((p) => p.identity === pinnedIdentity);
}
