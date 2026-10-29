/**
 * voiceNameClaimsApi — thin fetch client for /api/voice-name-claims.
 *
 * Filing a name is filing a CLAIM (never a rename). The server owns
 * verification; this module only moves claim rows.
 */
import type { VoiceNameClaimView } from './voiceIdentityUtils';

const API_BASE = '/api/voice-name-claims';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _raw: text };
  }
}

export async function listVoiceNameClaims(voiceKey: string): Promise<VoiceNameClaimView[]> {
  const res = await fetch(`${API_BASE}?voiceKey=${encodeURIComponent(voiceKey)}`);
  if (!res.ok) throw new Error(`list claims failed: ${res.status}`);
  const body = await readJson(res);
  return Array.isArray(body.claims) ? body.claims : [];
}

export interface FileClaimArgs {
  voiceKey: string;
  claimedName: string;
  claimBy?: string;
  livekitIdentity?: string;
}

export async function fileVoiceNameClaim(args: FileClaimArgs): Promise<VoiceNameClaimView> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(body?.error || `file claim failed: ${res.status}`);
  return body.claim;
}

export interface ConfirmResult {
  claim: VoiceNameClaimView;
  verified: boolean;
  reason?: string;
}

export async function confirmVoiceNameClaim(args: {
  voiceKey: string;
  claimedName: string;
  steward?: boolean;
}): Promise<ConfirmResult> {
  const path = args.steward ? `${API_BASE}/steward-confirm` : `${API_BASE}/confirm`;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceKey: args.voiceKey, claimedName: args.claimedName }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(body?.error || `confirm failed: ${res.status}`);
  return body;
}
