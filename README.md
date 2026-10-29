# coexistir-door

The public front-door slice of the Coexistir community portal: an always-on,
desktop-first voice door (`/portal`) with a Live2D stage, a streaming speech
bridge, and community voice-name claims. No game lobby, no telemetry, no
mocks — when the bridge is down the panels say so.

Public repo: `https://github.com/liminalcommons/coexistir-door` · MIT license
(see `LICENSE`; Live2D assets have their own terms below).

## Inspiration

Coexistir is a real intentional community. It runs on the things most
communities run on: meals, favors, a shared kitchen, and memory. Who cooked.
Who kept their word. Who was at the table when the thing was decided. None of
that lives in a database. It lives in people, and in scrollback.

Two failures kept showing up. Translation and assistant apps assume a personal
device in the conversational path: the phone becomes the addressee, turn gaps
stretch, and whoever holds it holds the floor. And assistants reset every
session, so a community's memory ends up in a chat log and in whoever was
paying attention.

This door is the opposite bet: a screen that belongs to nobody, a voice that
carries words without inventing them, and names that attach as claims the
community verifies — never as guesses the machine makes. This repo is the
portal slice of that larger CommunityOS story: the door, the voice bridge, the
claims, and the stage. Nothing here renames anyone; "unknown" is a deliberate
product answer, not a missing feature.

## What it does

Three surfaces and one trust rule: someone speaks, the system carries the
words, and only what the community verifies becomes identity.

**The door (`/portal`).** `PortalPage` + `PortalStage`: an AudioWorklet ear
(`portalVad`), streaming STT (`portalSttStream`), door state machine and
timings, `VoiceIdPanel`, `VoiceEnrollPanel`. The public view has no rail, no
voice key, no transcript words; `?debug=1` opens the rail with Voice-ID →
transcript → event log.

**The voice bridge.** Deepgram STT/stream in, TTS stream out, chunked-audio
streaming transport, consult pending/answer flow, house transcript log. Two
loops: a ~95 ms reflex lane (Groq `qwen/qwen3.8-27b`) for smalltalk, and a
composed manager turn for household state. The route never answers from
scratch on the composed turn — it composes deterministic text from real task
rows first (see the Nemotron lane below).

**Voice-name claims — claims, not names.** There is no speaker-embedding stage
in this slice: `VoiceIdentity.biometric` is always `false` and `confidence`
always `null`. A name attaches as a **claim only** (never a rename), verified
by repeat matching claims (quorum) or steward confirm; a single self-claim
stays unverified and is displayed that way. A `guest` voiceprint carries no
identity. Details in `docs/voice-name-claims.md`; bridge design in
`docs/coexistir-voice-bridge.md`.

**The stage.** `CoexistirLive2DStage` / `CubismAvatar` with motion, sentiment,
and stage triggers. Vendored Cubism `core/` + `shaders/` only — **no model
payloads** (see Live2D licences below); the stage reports `Rig offline` until
you fill them locally.

## The Nemotron lane (measured)

The composed manager turn has an optional polish lane powered by NVIDIA
Nemotron via the NIM free tier (no card, OpenAI-compatible
`https://integrate.api.nvidia.com/v1/chat/completions`). The repo default is
`nvidia/nemotron-3.5-lightning-30b-a3b` — the successor of
`nvidia/nemotron-3-nano-30b-a3b`, which NIM retired (410 Gone since
2026-09-01). Nemotron only ever **rephrases** the deterministic briefing —
with a no-invention grounding rule — and without a key the briefing passes
through unchanged with `provider.fallback=true`, so the door stays honest.

Measured on live streaming calls (max_tokens 80/120) against
`nvidia/nemotron-3-nano-30b-a3b` via a mirror serving the identical weights:

| Prompt | TTFT | Total | Result |
|---|---|---|---|
| PT grounded (briefing with 2 real tasks, rephrase-only) | 558 ms | 626 ms | PASS — both tasks named, nothing added |
| PT ungrounded ("Bom dia! O que ainda está aberto…?") | 1,068 ms | 2,608 ms | FAIL — fabricated shop names + hours |
| EN ungrounded ("Good morning! What's still open…?") | 534 ms | 821 ms | FAIL — invented "kitchen is open, coffee's ready" |

The ungrounded failures are the point: Nemotron hallucinates house state when
asked to answer from scratch, which is why this architecture never lets it.
Reflex smalltalk stays on the ~95 ms lane; the composed turn renders its
deterministic text first and polishes second. A live-NIM probe of the default
(3.5-lightning, grounded rephrase, reasoning off) returned TTFT ~0.22–0.26 s,
total ~0.36–0.52 s (PT+EN, 2 trials each); with thinking on, the reply never
arrives (content=null), hence reasoning off. Route-level smoke verified over
real HTTP (4/4: default unchanged, polish via injected lane, `/nemotron`
probe, no-key fallback identical).

Free-tier key (2 minutes, no card): create a free account at
`https://build.nvidia.com` (Login → Create an Account), generate a key at
`https://build.nvidia.com/settings`, paste it as `NEMOTRON_API_KEY` in `.env`.

## What's inside

| Path | What |
|---|---|
| `packages/client/src/portal/` | Door UI: `PortalPage`, `PortalStage`, worklet ear (`portalVad`), streaming STT (`portalSttStream`), door state/timings, `VoiceIdPanel`, `VoiceEnrollPanel` |
| `packages/client/src/coexistir/` | Realtime voice client: `realtimeVoice`, `agentVoice`, barge-in, room chat, manager/tasks APIs |
| `packages/client/src/live2d/` | `CoexistirLive2DStage`, `CubismAvatar`, motion/sentiment/stage triggers, Cubism Web Framework 5-r.5 source (`framework/`, unmodified) |
| `packages/client/src/components/views/` | `CoexistirManagerTile`, name-that-voice dialog + claim API, pin/focus overlays |
| `packages/client/scripts/door/` | Behavioural door probes (headless Chromium + fake capture device; see `packages/client/scripts/door/README.md`) |
| `packages/client/public/live2d/` | Vendored Cubism `core/` + `shaders/` only — **no model payloads** (see below) |
| `packages/server/routes/coexistirVoiceRoutes.ts` | `POST /api/coexistir/voice/stt\|turn\|stream`, `GET …/turns`, `id/latest\|events\|stream`, `consult/pending\|answer` |
| `packages/server/routes/coexistirVoiceStream.ts` | Chunked-audio streaming transport |
| `packages/server/routes/coexistirManagerRoutes.ts` | Composed manager turn (claim-named); `GET /turn?model=nemotron` polish lane + `GET /nemotron` probe |
| `packages/server/routes/coexistirTaskRoutes.ts` | Shared household todos (`zone=coexistir`) |
| `packages/server/routes/voiceNameClaimRoutes.ts` | Voice-name claims + quorum/steward verification |
| `packages/server/modules/voice/` | Deepgram STT/stream, TTS stream, door language, enrollment, acoustic snapshot, voice-ID bus/identity, house transcript |
| `packages/server/modules/coexistir/` | `managerPersona`, task repository, reflex talker, `nemotronTurn` polish lane |
| `packages/server/modules/naming/` | Claim display names, claim policy, voice identity |
| `packages/server/models/CoexistirTask.ts` | Task schema |
| `docs/voice-name-claims.md` | Claim schema + bridge-lite verification rule |
| `docs/coexistir-voice-bridge.md` | Voice bridge design |

## Setup

Prerequisites: Node 18+, a running app shell to mount this slice into (client
and server `package.json` files live in the monorepo — this slice carries
source, not manifests).

```bash
git clone https://github.com/liminalcommons/coexistir-door.git
cd coexistir-door
cp .env.example .env   # then fill real keys locally — .env is gitignored, never commit it
node scripts/live2d/sync-live2d-assets.mjs /path/to/live2d-samples  # fills the gitignored model payloads
```

Install the deps the imports name (`express`, `livekit-server-sdk`,
`deepgram` SDK, `livekit-client`, `vite`, `react`), mount the routes and the
`/portal` page, and point the client at the server. Key endpoints once mounted
(see `packages/client/src/portal/portalApi.ts`):

- `GET /api/coexistir/manager/turn` — composed manager text (claim-named)
- `GET /api/coexistir/manager/turn?model=nemotron` — same briefing, Nemotron-polished (falls back unchanged without a key)
- `GET /api/coexistir/manager/nemotron` — polish-lane probe (reports ready/missing-key, never leaks the key)
- `POST /api/coexistir/voice/turn` — ordered speak plan + house-log row
- `GET /api/coexistir/voice/events` — audio rows (first-chunk timings)
- `GET /api/coexistir/voice/health` — bridge + consult inventory
- `GET /api/voice-name-claims` — community claim rows (public read)

## Judge path (how to verify this repo)

1. **Read the honesty surfaces.** Load `/portal` and `/portal?debug=1`: the
   public view shows no rail/voiceKey/transcript; the debug rail shows the
   identity rows that exist *and* the rows that say what does not exist
   (`voiceprint: not computed`, `confidence: unknown`).
2. **Run the door probes.** Against a running rig
   (`http://localhost:4030/portal`, keys in `.env`, clips staged per
   `packages/client/scripts/door/README.md`): `door-modes.mjs` (handsfree,
   barge-in, deaf, silence, cutoff, pauses, gated), `door-layout.mjs`
   (2560×1440 / 1366×768 / 390×844), `door-panels.mjs` (debug panes + full
   Live2D trigger map), `door-audio-capture.mjs` (main-thread starvation).
   Every probe exits non-zero on failure — pass/fail, not a score.
3. **Run the unit tests** colocated with the source (`__tests__/` next to
   every module, including the Nemotron lane and route tests).
4. **Probe the Nemotron lane.** `GET /nemotron` with no key reports the lane
   missing-key; with `NEMOTRON_API_KEY` set, `GET /turn?model=nemotron`
   returns the polished briefing with provider metadata.
5. [FILL: demo video URL — a three-minute walkthrough showing the door, the
   room, the voice label, and the record. Not recorded yet.]

## Challenges we ran into (portal scope)

- **A confident wrong name.** A good-looking similarity score with a thin
  margin is exactly the kind of number that talks you into naming someone.
  This slice answers by construction: no embeddings, no scores — claims with
  quorum or steward confirm, and "unknown" displayed deliberately.
- **Ungrounded models invent the house.** Measured above: Nemotron fabricates
  opening hours and kitchen state when asked to answer from scratch. The
  two-loop design (deterministic compose → rephrase-only polish) exists
  because of that measurement, not in spite of it.
- **The demo is not the system.** A tunnel that rotates URLs, a hidden
  subscriber starved of frames, a mic that is deterministic only with a fake
  capture device. The probes encode these as checks, not anecdotes.

## What we learned

- **Form factor is the product.** A screen in the middle of the table,
  belonging to nobody, is a different object from a phone held by the person
  who needs help.
- **Errors must be visible and cheap.** The debug rail prints what is missing
  on purpose. No model ever rewrites a transcript; the door carries words, it
  does not produce them.
- **Identity is the whole game.** "Who said that, really?" consumed more
  design than any model choice — and the correct answer is often "unknown".
- **Models are last.** Mic quality, vocabulary, and grounding beat model
  choice; the model polishes the sentence, never the facts.

## What's next

- **Measure the wired Nemotron lane on a real conversation.** Single-turn
  grounded rephrase on the default model is ~0.22–0.26 s TTFT / ~0.36–0.52 s
  total over live NIM; next is latency over a full real conversation.
- **Ship the demo video.** [FILL: record and link the three-minute
  walkthrough — door, room, voice label, record.]
- **Use the door at a real gathering.** Compare curated output with verbatim
  and tune thresholds from what people experience, not from a benchmark.
- **Close the memory loop.** The larger system files turns to per-person
  threads; reading them back with citation discipline (ids travel with the
  sentence, agent still cannot write) is specified, not built — and outside
  this slice.
- [FILL: one human number — residents, meals, or messages — only if you have
  it. Do not estimate.]

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

## License

MIT — see `LICENSE`. The Live2D terms above apply to their files in addition.
