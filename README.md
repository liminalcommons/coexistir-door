# coexistir-door

The public front-door slice of Castalia's Coexistir portal: an always-on,
desktop-first voice door (`/portal`) with a Live2D stage, a streaming
speech bridge, and community voice-name claims. No game lobby, no telemetry,
no mocks — when the bridge is down the panels say so.

Fresh single-commit export. No monorepo history is included.

## What is inside

| Path | What |
|---|---|
| `packages/client/src/portal/` | Door UI: `PortalPage`, `PortalStage`, worklet ear (`portalVad`), streaming STT (`portalSttStream`), door state/timings, `VoiceIdPanel`, `VoiceEnrollPanel` |
| `packages/client/src/coexistir/` | Realtime voice client: `realtimeVoice`, `agentVoice`, barge-in, room chat, manager/tasks APIs |
| `packages/client/src/live2d/` | `CoexistirLive2DStage`, `CubismAvatar`, motion/sentiment/stage triggers, Cubism Web Framework 5-r.5 source (`framework/`, unmodified) |
| `packages/client/src/components/views/` | `CoexistirManagerTile`, name-that-voice dialog + claim API, pin/focus overlays |
| `packages/client/scripts/door/` | Behavioural door probes (headless Chromium + fake capture device) |
| `packages/client/public/live2d/` | Vendored Cubism `core/` + `shaders/` only — **no model payloads** (see below) |
| `packages/server/routes/coexistirVoiceRoutes.ts` | `POST /api/coexistir/voice/stt|turn|stream`, `GET …/turns`, `id/latest|events|stream`, `consult/pending|answer` |
| `packages/server/routes/coexistirVoiceStream.ts` | Chunked-audio streaming transport |
| `packages/server/routes/coexistirManagerRoutes.ts` | Composed manager turn (claim-named) |
| `packages/server/routes/coexistirTaskRoutes.ts` | Shared household todos (`zone=coexistir`) |
| `packages/server/routes/voiceNameClaimRoutes.ts` | Voice-name claims + quorum/steward verification |
| `packages/server/modules/voice/` | Deepgram STT/stream, TTS stream, door language, enrollment, acoustic snapshot, voice-ID bus/identity, house transcript |
| `packages/server/modules/coexistir/` | `managerPersona`, task repository, reflex talker |
| `packages/server/modules/naming/` | Claim display names, claim policy, voice identity |
| `packages/server/models/CoexistirTask.ts` | Task schema |
| `docs/voice-name-claims.md` | Claim schema + bridge-lite verification rule |
| `docs/coexistir-voice-bridge.md` | Voice bridge design |

## Quick start

```bash
cp .env.example .env   # then fill real keys locally — .env is gitignored, never commit it
node scripts/live2d/sync-live2d-assets.mjs /path/to/live2d-samples  # fills the gitignored model payloads
```

Client and server `package.json` files live in the monorepo; wire this slice
into your app shell and install the deps the imports name (`express`,
`livekit-server-sdk`, `deepgram` SDK, `livekit-client`, `vite`, `react`).

Key endpoints once mounted (see `packages/client/src/portal/portalApi.ts`):

- `GET /api/coexistir/manager/turn` — composed manager text (claim-named)
- `POST /api/coexistir/voice/turn` — ordered speak plan + house-log row
- `GET /api/coexistir/voice/events` — audio rows (first-chunk timings)
- `GET /api/coexistir/voice/health` — bridge + consult inventory
- `GET /api/voice-name-claims` — community claim rows (public read)

## Voice identity, honestly

There is no speaker-embedding stage in this stack. `VoiceIdentity.biometric`
is always `false` and `confidence` always `null`; names attach as **claims
only** (never renames), verified by repeat matching claims (quorum) or
steward confirm. A `guest` voiceprint carries no identity. Details in
`docs/voice-name-claims.md`.

## Live2D licences (three, not interchangeable)

- `packages/client/public/live2d/core/live2dcubismcore.min.js` — Live2D
  **Proprietary** Software License; redistribution of this exact file is
  explicitly allowed (`core/RedistributableFiles.txt`).
- `shaders/` + `src/live2d/framework/` — Live2D Open Software License
  (`LICENSE.md`, `NOTICE.md` kept alongside).
- `public/live2d/models/` — **not included, gitignored**. The Live2D Free
  Material License does not grant redistribution of raw materials. Fill it
  locally with the sync script; the stage reports `Rig offline` until then.

The stage credit line ("This content uses sample data owned and copyrighted
by Live2D Inc.") must stay in any published build.
