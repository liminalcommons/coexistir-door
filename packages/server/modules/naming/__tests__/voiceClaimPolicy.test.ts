/**
 * voiceClaimPolicy.test.ts — Bridge-lite name-claim rules.
 *
 * Pins the guest-kind rule (claims, never identity) and the verification
 * quorum: steward confirm wins; otherwise >=2 distinct claimants.
 */

import {
  normalizeClaimName,
  validateClaimedName,
  validateClaimBy,
  isGuestSpeakerLabel,
  voiceKeyForTile,
  owlClusterForVoiceKey,
  knowledgeGroupForVoiceKey,
  evaluateClaimVerification,
} from '../voiceClaimPolicy';

describe('normalizeClaimName', () => {
  it('trims, collapses whitespace, and casefolds', () => {
    expect(normalizeClaimName('  Zoe   Rivera ')).toBe('zoe rivera');
    expect(normalizeClaimName('ZOE')).toBe('zoe');
  });
});

describe('validateClaimedName', () => {
  it('rejects missing/blank/non-string names', () => {
    expect(validateClaimedName('')).not.toBeNull();
    expect(validateClaimedName('   ')).not.toBeNull();
    expect(validateClaimedName(undefined)).not.toBeNull();
    expect(validateClaimedName(123)).not.toBeNull();
  });

  it('rejects names over the max length', () => {
    expect(validateClaimedName('x'.repeat(41))).not.toBeNull();
  });

  it('accepts a normal name', () => {
    expect(validateClaimedName('Zoe')).toBeNull();
  });
});

describe('validateClaimBy', () => {
  it('allows missing claimBy (defaults to guest downstream)', () => {
    expect(validateClaimBy(undefined)).toBeNull();
    expect(validateClaimBy(null)).toBeNull();
  });

  it('rejects blank or overlong claimBy', () => {
    expect(validateClaimBy('  ')).not.toBeNull();
    expect(validateClaimBy('x'.repeat(121))).not.toBeNull();
  });
});

describe('guest-kind rule helpers', () => {
  it('treats "guest" (any case/whitespace) as carrying no identity', () => {
    expect(isGuestSpeakerLabel('guest')).toBe(true);
    expect(isGuestSpeakerLabel(' Guest ')).toBe(true);
    expect(isGuestSpeakerLabel('GUEST')).toBe(true);
    expect(isGuestSpeakerLabel('spk_07')).toBe(false);
    expect(isGuestSpeakerLabel(undefined)).toBe(false);
  });

  it('voiceKeyForTile prefers a real Owl cluster, never "guest"', () => {
    expect(voiceKeyForTile({ owlSpeaker: 'spk_07', livekitIdentity: 'abc' })).toBe('owl:spk_07');
    expect(voiceKeyForTile({ owlSpeaker: 'guest', livekitIdentity: 'abc' })).toBe('livekit:abc');
    expect(voiceKeyForTile({ owlSpeaker: undefined, livekitIdentity: 'abc' })).toBe('livekit:abc');
    expect(voiceKeyForTile({ owlSpeaker: '  ', livekitIdentity: 'abc' })).toBe('livekit:abc');
  });

  it('owlClusterForVoiceKey extracts the cluster or null', () => {
    expect(owlClusterForVoiceKey('owl:spk_07')).toBe('spk_07');
    expect(owlClusterForVoiceKey('livekit:abc')).toBeNull();
  });

  it('knowledgeGroupForVoiceKey mirrors into the person thread', () => {
    expect(knowledgeGroupForVoiceKey('owl:spk_07')).toBe('coexistir-owl-spk_07');
    expect(knowledgeGroupForVoiceKey('livekit:abc')).toBe('coexistir-owl-unclaimed');
  });
});

describe('evaluateClaimVerification (Bridge-lite)', () => {
  it('a single non-steward claim stays unverified', () => {
    const r = evaluateClaimVerification({
      existing: [],
      normalizedName: 'zoe',
      claimBy: 'luiz',
      isSteward: false,
    });
    expect(r.verified).toBe(false);
    expect(r.matchingClaimants).toEqual(['luiz']);
  });

  it('two distinct matching claims verify (matching-claims)', () => {
    const r = evaluateClaimVerification({
      existing: [{ normalizedName: 'zoe', claimBy: 'luiz', status: 'unverified' }],
      normalizedName: 'zoe',
      claimBy: 'priya',
      isSteward: false,
    });
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('matching-claims');
    expect(r.matchingClaimants.sort()).toEqual(['luiz', 'priya']);
  });

  it('the same claimant twice does NOT verify', () => {
    const r = evaluateClaimVerification({
      existing: [{ normalizedName: 'zoe', claimBy: 'luiz', status: 'unverified' }],
      normalizedName: 'zoe',
      claimBy: 'luiz',
      isSteward: false,
    });
    expect(r.verified).toBe(false);
  });

  it('conflicting names do not pool toward quorum', () => {
    const r = evaluateClaimVerification({
      existing: [{ normalizedName: 'max', claimBy: 'luiz', status: 'unverified' }],
      normalizedName: 'zoe',
      claimBy: 'priya',
      isSteward: false,
    });
    expect(r.verified).toBe(false);
  });

  it('a steward confirm verifies immediately', () => {
    const r = evaluateClaimVerification({
      existing: [],
      normalizedName: 'zoe',
      claimBy: 'steward-1',
      isSteward: true,
    });
    expect(r.verified).toBe(true);
    expect(r.reason).toBe('steward-confirm');
  });
});
