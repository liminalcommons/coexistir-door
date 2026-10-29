/**
 * claimDisplayName — resolve a voiceKey to its community name claim.
 *
 * Slice-2 bridge for transcripts: voice identity stays keyed on `voiceKey`
 * (owl cluster / livekit identity), never the tile name. The display name
 * comes from the `voice_name_claims` collection:
 *   - a verified claim wins (newest verification first),
 *   - otherwise the latest claim is shown with an `unverified` marker.
 *
 * Reads are best-effort: any failure returns null so transcript ingest can
 * always fall back to the participant name.
 */

import { getWeaverDb } from '../../database/weaverDb';

export type ClaimNameStatus = 'verified' | 'unverified';

export interface ClaimDisplayName {
  name: string;
  status: ClaimNameStatus;
}

const COLLECTION = 'voice_name_claims';

export async function resolveClaimDisplayName(
  voiceKey: string,
): Promise<ClaimDisplayName | null> {
  const key = typeof voiceKey === 'string' ? voiceKey.trim() : '';
  if (!key) return null;

  const db = await getWeaverDb();
  const claims = db.collection(COLLECTION);

  const verified = await claims
    .find({ voiceKey: key, status: 'verified' })
    .sort({ verifiedAt: -1, claimAt: -1 })
    .limit(1)
    .toArray();
  if (verified.length > 0 && typeof verified[0].claimedName === 'string') {
    return { name: verified[0].claimedName, status: 'verified' };
  }

  const latest = await claims
    .find({ voiceKey: key })
    .sort({ claimAt: -1 })
    .limit(1)
    .toArray();
  if (latest.length > 0 && typeof latest[0].claimedName === 'string') {
    return { name: latest[0].claimedName, status: 'unverified' };
  }

  return null;
}
