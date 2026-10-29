/**
 * voiceClaimPolicy — Bridge-lite name-claim rules (pure, no I/O).
 *
 * Guest-kind rule (hard): never trust a 'guest' voiceprint or a
 * self-asserted name as identity. Names attach as CLAIMS only:
 *   { voiceKey, claimedName, claimBy, claimAt, status: 'unverified' }
 * A claim NEVER renames a participant, a voiceprint, or a memory thread.
 *
 * Verification (Bridge-lite):
 *   - a steward confirm flips matching claims to 'verified' immediately, OR
 *   - >=2 DISTINCT claimBy values file the same normalized name → verified.
 * A single non-steward claim (including self-claims) stays 'unverified'.
 *
 * Speak-to-enroll is the voice half beside this quorum: the supervised flow
 * binds a print to `person:<normalized-name>` and files the name verified
 * with reason 'enrollment'. The quorum above is unchanged — meeting tiles
 * still verify names by witnesses, and enrollment never touches those rows.
 *
 * voiceKey identifies the VOICE, not the person:
 *   - Owl speaker cluster:  `owl:<cluster>`  (e.g. `owl:spk_07`)
 *   - otherwise (no Owl label): `livekit:<participantIdentity>`
 *   - a voice bound by enrollment: `person:<normalized-name>` (the print and
 *     the name share this key; the door-wide kiosk key `owl:front-door` must
 *     never carry a personal name — it is every visitor's key, not someone's)
 * 'guest' (any case) is NEVER a voiceKey segment — the Owl worker emits
 * speaker:"guest" for unenrolled voices, which carries no identity.
 */

export type ClaimStatus = 'unverified' | 'verified';

/** Where a verified claim came from: steward sight, witness quorum, or voice. */
export type VerifyReason = 'steward-confirm' | 'matching-claims' | 'enrollment';

export interface VoiceNameClaim {
  _id?: unknown;
  voiceKey: string;
  claimedName: string;
  normalizedName: string;
  claimBy: string;
  livekitIdentity?: string;
  claimAt: string;
  status: ClaimStatus;
  verifiedAt?: string;
  verifiedBy?: string;
  verifyReason?: VerifyReason;
}

export const CLAIM_NAME_MAX_LEN = 40;
export const CLAIM_BY_MAX_LEN = 120;
export const MATCHING_CLAIMS_THRESHOLD = 2;

/** Normalize for comparison: trim, collapse inner whitespace, casefold. */
export function normalizeClaimName(name: string): string {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Validate a raw claimedName. Returns an error string or null when valid. */
export function validateClaimedName(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'claimedName must be a string';
  const trimmed = raw.trim();
  if (!trimmed) return 'claimedName is required';
  if (trimmed.length > CLAIM_NAME_MAX_LEN) {
    return `claimedName must be at most ${CLAIM_NAME_MAX_LEN} characters`;
  }
  return null;
}

/** Validate a raw claimBy. Returns an error string or null when valid. */
export function validateClaimBy(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null; // defaults to 'guest'
  if (typeof raw !== 'string') return 'claimBy must be a string';
  const trimmed = raw.trim();
  if (!trimmed) return 'claimBy must not be blank';
  if (trimmed.length > CLAIM_BY_MAX_LEN) {
    return `claimBy must be at most ${CLAIM_BY_MAX_LEN} characters`;
  }
  return null;
}

/** True when an Owl speaker label carries no identity (unenrolled voice). */
export function isGuestSpeakerLabel(speaker: unknown): boolean {
  return typeof speaker === 'string' && speaker.trim().toLowerCase() === 'guest';
}

/**
 * Build the voiceKey for a tile. Owl cluster wins when it names a real
 * enrolled speaker; otherwise fall back to the LiveKit identity so every
 * stranger tile still has a stable, claimable key.
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

/** Owl cluster segment of an `owl:<cluster>` voiceKey, else null. */
export function owlClusterForVoiceKey(voiceKey: string): string | null {
  if (typeof voiceKey !== 'string') return null;
  const m = /^owl:(.+)$/.exec(voiceKey.trim());
  return m ? m[1] : null;
}

/**
 * Graphiti/cortex group that mirrors claims for this voice: the person's
 * thread `coexistir-owl-<cluster>`. A voice bound by enrollment mirrors to
 * its own thread `coexistir-person-<name>` — the supervised binding is the
 * one path that may open a named thread. Anything else mirrors to the shared
 * `coexistir-owl-unclaimed` group — still a claim, never an identity.
 */
export function knowledgeGroupForVoiceKey(voiceKey: string): string {
  const cluster = owlClusterForVoiceKey(voiceKey);
  if (cluster) return `coexistir-owl-${cluster}`;
  const person = /^person:(.+)$/.exec(voiceKey.trim());
  if (person) return `coexistir-person-${person[1]}`;
  return 'coexistir-owl-unclaimed';
}

export interface VerificationInput {
  /** Existing claims for the same voiceKey (any status). */
  existing: Array<Pick<VoiceNameClaim, 'normalizedName' | 'claimBy' | 'status'>>;
  /** Normalized name of the claim/confirmation being evaluated. */
  normalizedName: string;
  /** Distinct claimant of the new claim/confirmation. */
  claimBy: string;
  /** True when the confirmer is a deployment steward. */
  isSteward: boolean;
}

export interface VerificationResult {
  verified: boolean;
  reason?: 'steward-confirm' | 'matching-claims';
  /** Distinct claimants behind the matching name (incl. the new one). */
  matchingClaimants: string[];
}

/**
 * Bridge-lite verification: steward confirm wins outright; otherwise the
 * normalized name needs MATCHING_CLAIMS_THRESHOLD distinct claimants.
 * Already-verified rows count toward the quorum (repeat matches keep it so).
 */
export function evaluateClaimVerification(input: VerificationInput): VerificationResult {
  const distinct = new Set<string>();
  for (const c of input.existing) {
    if (c.normalizedName === input.normalizedName && c.claimBy) {
      distinct.add(c.claimBy);
    }
  }
  distinct.add(input.claimBy);

  if (input.isSteward) {
    return { verified: true, reason: 'steward-confirm', matchingClaimants: [...distinct] };
  }
  if (distinct.size >= MATCHING_CLAIMS_THRESHOLD) {
    return { verified: true, reason: 'matching-claims', matchingClaimants: [...distinct] };
  }
  return { verified: false, matchingClaimants: [...distinct] };
}
