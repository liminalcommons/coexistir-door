# NAME-THAT-VOICE — Bridge-lite name claims

Two meeting features shipped together: **PIN/FOCUS** a participant's video
(`PinnedTileOverlay`, `pinUtils`, `TileOverlayActions`) and **NAME-THAT-VOICE**
on stranger tiles. This doc covers the name-claim rule, schema, and the human
verification script. Pin behavior is documented in code (`pinUtils.ts`,
`PinnedTileOverlay.tsx`).

## Guest-kind rule (hard, never relax silently)

- A `guest` voiceprint (Owl `speaker: "guest"`, any case) carries **no identity**.
- A self-asserted name (LiveKit display name, chat claim, voice claim by the
  speaker about their own voice) carries **no identity**.
- Names attach as **CLAIMS only**. No claim path renames a participant, a
  voiceprint, or a memory thread — the tile keeps showing the LiveKit name
  (or identity); the claimed name renders beside it with an `unverified`
  marker until verified.

## Claim schema (`mongo: castalia.voice_name_claims`)

```ts
{
  voiceKey: string;       // `owl:<cluster>` for enrolled Owl speakers,
                          // else `livekit:<participantIdentity>`. Never `guest`.
  claimedName: string;    // raw, trimmed, max 40 chars
  normalizedName: string; // trim + collapse spaces + lowercase (quorum key)
  claimBy: string;        // authed display name, else body claimBy, else 'guest'
  livekitIdentity?: string;
  claimAt: string;        // ISO
  status: 'unverified' | 'verified';
  verifiedAt?: string;
  verifiedBy?: string;    // steward name, or 'quorum'
  verifyReason?: 'steward-confirm' | 'matching-claims';
}
```

Indexes to add when traffic warrants: `{ voiceKey: 1, claimAt: 1 }`,
`{ voiceKey: 1, normalizedName: 1 }` (reads/writes are single-voice scoped).

## Bridge-lite verification rule

Implemented pure in `packages/server/modules/naming/voiceClaimPolicy.ts`
(`evaluateClaimVerification`), applied by `voiceNameClaimRoutes.ts`:

1. **Single non-steward claim → `unverified`.** Filing twice under the same
   `claimBy` never verifies (no self-promotion).
2. **Repeat matching claims → `verified`.** A second *distinct* `claimBy`
   filing the same `normalizedName` flips all matching rows to `verified`
   (`verifyReason: 'matching-claims'`, `verifiedBy: 'quorum'`).
3. **Steward/villager confirm** (`POST /api/voice-name-claims/confirm`,
   auth required): a steward confirm verifies immediately
   (`verifyReason: 'steward-confirm'`); an authenticated villager's confirm
   is recorded as their own matching claim and may complete the 2-match
   quorum. `POST /api/voice-name-claims/steward-confirm` is the steward-only
   alias (same gating style as `mapRoutes`).

Only `unverified → verified` transitions exist; claims are never edited or
deleted by these endpoints.

## Graphiti mirror

Every write is mirrored fire-and-forget as an episode via the system
`KnowledgePort` (Cortex-backed) into the voice's thread:

- voiceKey `owl:<cluster>` → group `coexistir-owl-<cluster>` (the person's
  thread — the only path that ever writes a NAMED thread; stranger and
  guest-voice threads stay untouched until a claim verifies),
- any other voiceKey → group `coexistir-owl-unclaimed`.

Mirror failures log a warning and never fail the claim write.

## Live speaker labels (owl-speaker → tiles)

`useOwlSpeakerLabels(room)` subscribes to the LiveKit `owl-speaker` data
topic. Besides `getLabel(identity)` it exposes `activeSpeakerIdentity` —
the freshest label's owner, cleared `OWL_SPEAKING_TTL_MS` (3s) after the
last label so the indicator turns off by itself. Newest label wins.

`CastaliaMeetingView` maps it to tiles two ways:

- **Speaking indicator** — `withOwlSpeakingOverride(participants, id)`
  (`mergeTwinParticipants.ts`) swaps the live speaker's entry for an
  `Object.create` facade with `isSpeaking: true`, so the tile ring /
  spotlight pulse lights even when LiveKit audio levels missed the
  utterance. Null/unknown ids return the array untouched; the store-owned
  participant is never mutated. The owl-active roster member also wins the
  spotlight's `speakers.current` slot.
- **Voice fingerprint** — `voiceFingerprintShortHash(speaker)`
  (`voiceIdentityUtils.ts`) renders an enrolled cluster as a stable 6-hex
  chip (`◍ #7e12e3`) beside the name-claim CTA / claimed name. `guest`,
  blank, and non-string speakers yield `null` (guest-kind rule), so guest
  strangers keep the plain CTA.

## Stranger-tile detection (client)

`packages/client/src/components/views/voiceIdentityUtils.ts`:

- stranger ⟺ no LiveKit `name` OR latest `owl-speaker` label has
  `stranger: true`. Hooks: `useOwlSpeakerLabels(room)` subscribes to the
  LiveKit `owl-speaker` data topic `{speaker, score, stranger, margin,
  runner_up, participantIdentity?}`.
- voiceKey mirrors the server derivation (Owl cluster wins, never `guest`).
- Tile shows 🏷️ **Name this voice** when no claim exists; otherwise the
  claimed name + `(unverified)` chip until verified. The pinned overlay
  shows the same chip; the dialog lists all claims for the voice.

## API

| Method | Path | Auth | Body / query |
|---|---|---|---|
| POST | `/api/voice-name-claims` | none (guests file) | `{ voiceKey, claimedName, claimBy?, livekitIdentity? }` → `201 { claim }` |
| GET | `/api/voice-name-claims?voiceKey=` | none | → `{ voiceKey, claims[] }` |
| POST | `/api/voice-name-claims/confirm` | `isAuthenticated` | `{ voiceKey, claimedName }` → `{ claim, verified, reason? }` |
| POST | `/api/voice-name-claims/steward-confirm` | steward | same as confirm, verifies immediately |

## Human verification script (3 steps, ~5 min, needs a live zone)

1. **Pin Zoe.** Join a zone with ≥2 participants. Click Zoe's tile → it
   expands near-fullscreen (name bar, ✕, ⋯). Click the enlarged tile again
   (or ✕, or Esc) → it unpins. Change layout (Spotlight ⇄ Gallery) while
   pinned → the same participant stays expanded.
2. **Name a stranger tile.** Find a tile with no LiveKit name (or an
   Owl-flagged stranger) → it shows 🏷️ **Name this voice**. Enter `Zoe`,
   file → tile chip reads `Zoe (unverified)`; reopen shows your claim row.
3. **Confirm the claim row in mongo.**
   `db.voice_name_claims.find({ voiceKey: "<key from step 2>" })` →
   one row, `status: 'unverified'`. From a second user (or steward confirm),
   claim/confirm `Zoe` again → both rows flip to `verified`, and the tile
   chip loses the `(unverified)` marker.

## Speak-to-enroll (the voice half — front door only)

A typed claim is never an identity: the kiosk key `owl:front-door` is every
visitor's key, so a personal name must never sit on it (Oct 2026: two
`Fluran` demo rows typed by `door-qexmog` were moved to `owl:demo` for
exactly this reason). Speak-to-enroll binds the name BY VOICE instead:

- `POST /api/coexistir/voice/id/enroll/start { name, supervisedBy }` →
  `{ enrollmentId, voiceKey: 'person:<name>', prompt, needClips: 3 }`.
  Sessions are in-memory, TTL 10 min; enrollment clips never enter the
  turn/bus/consult path.
- `POST …/enroll/clip?enrollmentId=` (raw WAV, ×2–3) → per-take
  `{ voicedSec, f0Hz, consistency }`. Too short / silent / non-WAV clips
  are refused, not guessed.
- `POST …/enroll/finish { enrollmentId }` → averages the prints,
  persists ONE print via `VoiceprintRegistry.enroll` under `person:<name>`
  (never the kiosk key), and files the name `verified` with
  `verifyReason: 'enrollment'`. Mixed-voice sets (`consistency < 0.70`)
  and single-clip sessions are refused.
- `POST …/enroll/verify?voiceKey=` (raw WAV) → re-speak check against
  the 0.82 identity bar. The owner must clear it; a stranger must not.

After binding, the existing turn rule does the rest unchanged: `identified`
needs an enrolled match AND a resolved claim; a stranger matches nothing
and stays `unknown` — even when a name was once typed. The quorum above is
untouched: meeting tiles still verify by witnesses, and enrollment never
touches those rows.

Real-voice tuning note (Oct 2026): synthetic voices sit at ~0.96
same / ~0.12 across, so 0.70/0.82 have a wide margin; real rooms, mics and
colds narrow it. The re-speak verification is the backstop — if it fails
for the true owner, re-enroll closer to the kiosk mic instead of lowering
the bar.
