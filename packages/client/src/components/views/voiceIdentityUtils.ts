/**
 * voiceIdentityUtils — client-side mirror of the server Bridge-lite policy.
 *
 * Guest-kind rule (hard): 'guest' voiceprints and self-asserted names are
 * never identity. Names attach as CLAIMS only. This file mirrors
 * `packages/server/modules/naming/voiceClaimPolicy.ts` for tile display
 * decisions; the server remains the authority on verification.
 */

export interface OwlSpeakerLabel {
  speaker?: string | null;
  score?: number | null;
  stranger?: boolean;
  margin?: number | null;
  /** Runner-up cluster id from the worker (informational: disambiguation context). */
  runner_up?: string | null;
  participantIdentity?: string | null;
  participantName?: string | null;
  [key: string]: unknown;
}

/** True when an Owl speaker label carries no identity (unenrolled voice). */
export function isGuestSpeakerLabel(speaker: unknown): boolean {
  return typeof speaker === 'string' && speaker.trim().toLowerCase() === 'guest';
}

/**
 * Short display fingerprint for an enrolled Owl voiceprint cluster.
 *
 * FNV-1a (32-bit) over the trimmed cluster id, rendered as 6 lowercase hex
 * chars. Stable per cluster, short enough for a tile chip. Returns null for
 * guest/empty/non-string speakers — per the guest-kind rule a `guest`
 * voiceprint carries no identity, so it gets no fingerprint either.
 */
export function voiceFingerprintShortHash(speaker: unknown): string | null {
  if (typeof speaker !== 'string') return null;
  const id = speaker.trim();
  if (id === '' || isGuestSpeakerLabel(id)) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * A tile is a stranger tile when it has no LiveKit name OR the Owl worker
 * labels its speaker a stranger. Named tiles with a stranger label stay
 * stranger (the name is untrusted until a claim verifies).
 */
export function isStrangerTile(
  participant: { name?: string | null },
  owlLabel?: OwlSpeakerLabel | null,
): boolean {
  if (!participant?.name || !participant.name.trim()) return true;
  return !!owlLabel?.stranger;
}

/**
 * Stable claim key for a tile. Owl cluster wins when it names a real
 * enrolled speaker; otherwise fall back to the LiveKit identity.
 */
export function voiceKeyForTile(args: {
  owlSpeaker?: unknown;
  livekitIdentity: string;
}): string {
  const { owlSpeaker, livekitIdentity } = args;
  if (
    typeof owlSpeaker === 'string' &&
    owlSpeaker.trim() !== '' &&
    !isGuestSpeakerLabel(owlSpeaker)
  ) {
    return `owl:${owlSpeaker.trim()}`;
  }
  return `livekit:${livekitIdentity}`;
}

export interface VoiceNameClaimView {
  _id?: unknown;
  voiceKey: string;
  claimedName: string;
  normalizedName?: string;
  claimBy: string;
  claimAt?: string;
  status: 'unverified' | 'verified';
}

/** Display pick: verified claim wins, else the latest unverified claim. */
export function pickDisplayClaim(claims: VoiceNameClaimView[]): VoiceNameClaimView | null {
  if (!claims || claims.length === 0) return null;
  const verified = claims.filter((c) => c.status === 'verified');
  if (verified.length > 0) return verified[verified.length - 1];
  return claims[claims.length - 1];
}
