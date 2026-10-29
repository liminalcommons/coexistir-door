/**
 * voiceNameClaimRoutes — NAME-THAT-VOICE claim API (Bridge-lite).
 *
 * Guest-kind rule (hard): a name entered on a stranger tile is a CLAIM, not
 * an identity. Claims live in the NEW `voice_name_claims` collection only;
 * this router never renames participants, voiceprints, or memory threads.
 *
 *   POST /api/voice-name-claims
 *     File a claim. Public (guests can file). Body:
 *     { voiceKey, claimedName, claimBy?, livekitIdentity? }
 *     → 201 { claim } with status 'unverified', or 'verified' when the
 *     Bridge-lite rule fires (steward filer, or >=2 distinct matching claims).
 *
 *   GET /api/voice-name-claims?voiceKey=<key>
 *     List claims for one voice (newest last). Public read.
 *
 *   POST /api/voice-name-claims/confirm
 *     Villager/steward confirm. Requires auth (isAuthenticated).
 *     Body: { voiceKey, claimedName }. A steward confirm verifies
 *     immediately; an authenticated villager's confirm is recorded as their
 *     own matching claim and may complete the 2-match quorum.
 *     → 200 { claim, verified, reason? }
 *
 * Every write is mirrored fire-and-forget as a Graphiti/Cortex episode in
 * the voice's thread (coexistir-owl-<cluster>). Mirror failures never fail
 * the claim write.
 */

import { Router, Request, Response } from 'express';
import { getWeaverDb } from '../database/weaverDb';
import { isAuthenticated } from '../middleware/auth';
import { requireStewardAuth } from '../modules/auth';
import { isStewardForUser } from '../modules/auth/steward';
import User from '../models/User';
import {
  normalizeClaimName,
  validateClaimedName,
  validateClaimBy,
  evaluateClaimVerification,
  knowledgeGroupForVoiceKey,
  type VoiceNameClaim,
} from '../modules/naming/voiceClaimPolicy';

export const voiceNameClaimRouter = Router();

const COLLECTION = 'voice_name_claims';

async function claimsCollection() {
  const db = await getWeaverDb();
  return db.collection(COLLECTION);
}

/** Best-effort mirror of a claim into the voice's knowledge thread. */
async function mirrorClaimToKnowledge(
  claim: VoiceNameClaim,
  extra: { reason?: string } = {},
): Promise<void> {
  try {
    // Lazy import: keeps this router free of the knowledge barrel at load.
    const { defaultKnowledgePort } = await import('../modules/knowledge/defaultKnowledgePort');
    const port = defaultKnowledgePort();
    const groupId = knowledgeGroupForVoiceKey(claim.voiceKey);
    const statusLine = claim.status === 'verified' ? 'VERIFIED' : 'UNVERIFIED CLAIM';
    await port.addMemory(groupId, {
      name: `name-claim:${claim.voiceKey}:${claim.normalizedName}`,
      content:
        `[${statusLine}] Voice ${claim.voiceKey} was called "${claim.claimedName}" ` +
        `by ${claim.claimBy} at ${claim.claimAt}.` +
        (extra.reason ? ` Verification: ${extra.reason}.` : '') +
        ' This is a community name claim attached to a voice, not a verified identity.',
      source: 'name-that-voice',
      sourceDescription: 'Castalia meeting name-that-voice claim',
      metadata: {
        voiceKey: claim.voiceKey,
        claimedName: claim.claimedName,
        claimBy: claim.claimBy,
        status: claim.status,
      },
    });
  } catch (err) {
    console.warn('[voiceNameClaims] knowledge mirror failed (claim kept):', (err as Error)?.message);
  }
}

function collectionError(res: Response, err: unknown) {
  console.error('[voiceNameClaims] mongo error:', err);
  res.status(500).json({ error: 'Failed to access voice name claims' });
}

/** Resolve the caller's display identity: authed user wins, else body claimBy, else 'guest'. */
function resolveClaimBy(req: Request, bodyClaimBy: unknown): string {
  const user = (req as any).user;
  const authed: string | undefined =
    user?.displayName || user?.name || (user?._id ? String(user._id) : undefined);
  if (authed && authed.trim()) return authed.trim();
  if (typeof bodyClaimBy === 'string' && bodyClaimBy.trim()) return bodyClaimBy.trim();
  return 'guest';
}

// ── POST / — file a claim ────────────────────────────────────────────────────

voiceNameClaimRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { voiceKey, claimedName, livekitIdentity } = req.body ?? {};

    if (typeof voiceKey !== 'string' || !voiceKey.trim()) {
      res.status(400).json({ error: 'voiceKey is required' });
      return;
    }
    const nameErr = validateClaimedName(claimedName);
    if (nameErr) {
      res.status(400).json({ error: nameErr });
      return;
    }
    const byErr = validateClaimBy(req.body?.claimBy);
    if (byErr) {
      res.status(400).json({ error: byErr });
      return;
    }

    const claimBy = resolveClaimBy(req, req.body?.claimBy);
    const normalizedName = normalizeClaimName(claimedName);

    // Steward fast-path: an authed steward filing a claim verifies on sight.
    let callerIsSteward = false;
    try {
      const claims = await import('../modules/auth/castaliaSession').then(
        (m) => m.readSession(req),
      );
      if (claims?.sub) {
        const user = await User.findById(claims.sub)
          .select('hyloLink linkedAccounts logtoUserId clerkUserId email displayName name')
          .lean();
        if (user) {
          (req as any).user = user;
          callerIsSteward = isStewardForUser(user);
        }
      }
    } catch {
      // No usable session — plain community claim, stays unverified unless quorum.
    }

    const collection = await claimsCollection();
    const existing = (await collection
      .find({ voiceKey: voiceKey.trim() })
      .sort({ claimAt: 1 })
      .toArray()) as unknown as Array<{
      normalizedName: string;
      claimBy: string;
      status: 'unverified' | 'verified';
    }>;

    const verdict = evaluateClaimVerification({
      existing,
      normalizedName,
      claimBy,
      isSteward: callerIsSteward,
    });

    const now = new Date().toISOString();
    const claim: VoiceNameClaim = {
      voiceKey: voiceKey.trim(),
      claimedName: (claimedName as string).trim(),
      normalizedName,
      claimBy,
      livekitIdentity: typeof livekitIdentity === 'string' ? livekitIdentity : undefined,
      claimAt: now,
      status: verdict.verified ? 'verified' : 'unverified',
      ...(verdict.verified
        ? {
            verifiedAt: now,
            verifiedBy: callerIsSteward ? claimBy : 'quorum',
            verifyReason: verdict.reason,
          }
        : {}),
    };

    const inserted = await collection.insertOne(claim as any);

    // Bridge-lite quorum: a newly completed 2-match flips older matching
    // unverified claims to verified alongside the new row.
    if (verdict.verified && verdict.reason === 'matching-claims') {
      await collection.updateMany(
        {
          voiceKey: claim.voiceKey,
          normalizedName,
          status: 'unverified',
          _id: { $ne: inserted.insertedId },
        },
        { $set: { status: 'verified', verifiedAt: now, verifiedBy: 'quorum', verifyReason: 'matching-claims' } },
      );
    }

    const saved = { ...claim, _id: inserted.insertedId };
    void mirrorClaimToKnowledge(saved, { reason: verdict.reason });
    res.status(201).json({ claim: saved });
  } catch (err) {
    collectionError(res, err);
  }
});

// ── GET /?voiceKey= — list claims for one voice ─────────────────────────────

voiceNameClaimRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { voiceKey, limit = '50' } = req.query;
    if (typeof voiceKey !== 'string' || !voiceKey.trim()) {
      res.status(400).json({ error: 'voiceKey query param is required' });
      return;
    }
    const collection = await claimsCollection();
    const claims = await collection
      .find({ voiceKey: voiceKey.trim() })
      .sort({ claimAt: 1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .toArray();
    res.json({ voiceKey: voiceKey.trim(), claims });
  } catch (err) {
    collectionError(res, err);
  }
});

// ── POST /confirm — villager/steward confirm ─────────────────────────────────

voiceNameClaimRouter.post(
  '/confirm',
  isAuthenticated,
  async (req: Request, res: Response) => {
    try {
      const { voiceKey, claimedName } = req.body ?? {};
      if (typeof voiceKey !== 'string' || !voiceKey.trim()) {
        res.status(400).json({ error: 'voiceKey is required' });
        return;
      }
      const nameErr = validateClaimedName(claimedName);
      if (nameErr) {
        res.status(400).json({ error: nameErr });
        return;
      }

      const user = (req as any).user;
      const confirmBy: string =
        user?.displayName || user?.name || (req.userId ? String(req.userId) : 'villager');
      const callerIsSteward = isStewardForUser(user ?? ({ _id: req.userId } as never));
      const normalizedName = normalizeClaimName(claimedName);

      const collection = await claimsCollection();
      const existing = (await collection
        .find({ voiceKey: voiceKey.trim() })
        .sort({ claimAt: 1 })
        .toArray()) as unknown as VoiceNameClaim[];

      const verdict = evaluateClaimVerification({
        existing,
        normalizedName,
        claimBy: confirmBy,
        isSteward: callerIsSteward,
      });

      const now = new Date().toISOString();
      let claimDoc: VoiceNameClaim | null =
        existing.find(
          (c) => c.normalizedName === normalizedName && c.claimBy === confirmBy,
        ) ?? null;

      if (!claimDoc) {
        // A villager confirm is recorded as their own matching claim.
        const fresh: VoiceNameClaim = {
          voiceKey: voiceKey.trim(),
          claimedName: (claimedName as string).trim(),
          normalizedName,
          claimBy: confirmBy,
          claimAt: now,
          status: verdict.verified ? 'verified' : 'unverified',
          ...(verdict.verified
            ? { verifiedAt: now, verifiedBy: confirmBy, verifyReason: verdict.reason }
            : {}),
        };
        const inserted = await collection.insertOne(fresh as any);
        claimDoc = { ...fresh, _id: inserted.insertedId };
      }

      if (verdict.verified) {
        await collection.updateMany(
          { voiceKey: voiceKey.trim(), normalizedName },
          {
            $set: {
              status: 'verified',
              verifiedAt: now,
              verifiedBy: callerIsSteward ? confirmBy : 'quorum',
              verifyReason: verdict.reason,
            },
          },
        );
        claimDoc = { ...claimDoc, status: 'verified', verifiedAt: now };
        void mirrorClaimToKnowledge(claimDoc, { reason: verdict.reason });
      }

      res.json({ claim: claimDoc, verified: verdict.verified, reason: verdict.reason });
    } catch (err) {
      collectionError(res, err);
    }
  },
);

// Steward-only alias kept for symmetry with mapRoutes-style gating.
voiceNameClaimRouter.post(
  '/steward-confirm',
  isAuthenticated,
  requireStewardAuth,
  async (req: Request, res: Response) => {
    try {
      const { voiceKey, claimedName } = req.body ?? {};
      if (typeof voiceKey !== 'string' || !voiceKey.trim()) {
        res.status(400).json({ error: 'voiceKey is required' });
        return;
      }
      const nameErr = validateClaimedName(claimedName);
      if (nameErr) {
        res.status(400).json({ error: nameErr });
        return;
      }
      const normalizedName = normalizeClaimName(claimedName);
      const user = (req as any).user;
      const stewardName: string =
        user?.displayName || user?.name || (req.userId ? String(req.userId) : 'steward');

      const collection = await claimsCollection();
      const now = new Date().toISOString();
      await collection.updateMany(
        { voiceKey: voiceKey.trim(), normalizedName },
        {
          $set: {
            status: 'verified',
            verifiedAt: now,
            verifiedBy: stewardName,
            verifyReason: 'steward-confirm',
          },
        },
      );
      const updated = await collection
        .find({ voiceKey: voiceKey.trim(), normalizedName })
        .sort({ claimAt: 1 })
        .toArray();
      if (updated.length > 0) {
        void mirrorClaimToKnowledge(updated[updated.length - 1] as VoiceNameClaim, {
          reason: 'steward-confirm',
        });
      }
      res.json({ voiceKey: voiceKey.trim(), verified: true, reason: 'steward-confirm', claims: updated });
    } catch (err) {
      collectionError(res, err);
    }
  },
);
