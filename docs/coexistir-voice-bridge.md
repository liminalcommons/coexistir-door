# Coexistir realtime voice bridge (two-loop design)

Status: slice `castalia-coexistir-stream2`, built on the voicefix tip `f43e6117`.
Scratch rig only (`:4026`). Nothing here is deployed.

## The problem this fixes

`POST /api/tts/preview` awaited the whole Deepgram clip and then `res.send()`ed
it. Measured on the rig, that held 6–14s of silence before the first audible
byte and made barge-in impossible: by the time the browser had anything to play,
the provider call was already finished. The engine was never the problem —
Deepgram Flux delivers its first bytes in 250–500ms and stops cleanly when the
connection closes. The buffering was ours.

## Three loops, three latencies

```
member speaks
   │  (STT / scribe — unchanged)
   ▼
POST /api/coexistir/voice/turn ─────────────────────────────────────────────┐
   │  classifyTurn() — deterministic, no model call                          │
   │                                                                         │
   ├─ smalltalk ──► Groq qwen3.8-27b (reasoning_effort=none) ──► answer      │  loop 1: ~95ms
   │                                                                         │
   └─ hard ───────► honest filler spoken immediately  ──────────────────┐   │  loop 1: instant
                    │                                                    │   │
                    ├─ intent=briefing/todos/… ──► composeManagerTurn()  │   │  loop 2: data answer
                    │      (same Mongo rows the Tasks tab writes)        │   │
                    │                                                    │   │
                    └─ no data path ──► consult-queue.jsonl ──► Hermes  │   │  loop 3: async
                         (spoken ack: "Anotei essa pergunta…")           │   │
                                                                         ▼   │
POST /api/coexistir/voice/stream ◄── client asks for each step in order ─────┘
   │  chunked MP3, headers flushed before audio
   ▼
MediaSource append → audible in ~300–500ms; `stop()` aborts the HTTP request
```

**The ordering is explicit**: the turn response carries `sequence: [{role:'filler'}, {role:'answer'}]`
and the client only requests the answer stream after the filler step resolves.
The room never talks over itself, and the filler is never a lie — it says what
is being checked, and the answer that follows is composed from data or is
honestly deferred.

## Streaming audio

`packages/server/modules/voice/ttsStream.ts`

- resolves `(agentId, language)` through **one** voice table
  (`modules/voice/voiceProfiles.ts`) shared with `/api/tts/preview`, so the two
  paths can never disagree about who speaks;
- Deepgram Flux (`flux-mariana-pt`) on `/v2/speak`, Aura (`aura-2-thalia-en`) on
  `/v1/speak` — language lives in the model id, never a query param;
- sets `Transfer-Encoding: chunked`, flushes headers as soon as the provider
  accepts the request, writes every body chunk immediately, disables Nagle;
- tees the exact bytes to `audio/<turnId>.<kind>.mp3`;
- on client close (`res.on('close')` before end) it aborts the provider fetch —
  barge-in stops generation, not just playback;
- records `upstreamMs`, `headersFlushedMs`, `firstChunkMs`, `totalMs`, `bytes`,
  `chunks`, `aborted`, `abortMs`.

## Barge-in (client)

`packages/client/src/coexistir/realtimeVoice.ts` plays the MP3 progressively
with the Web Audio API: each arriving chunk is decoded and only the audio past
what is already scheduled is queued, so the first syllable is audible ~300–400ms
after the request and chunk boundaries stay inaudible (one decoder priming delay
per turn).

MediaSource was the first attempt and is documented here because it failed for a
non-obvious reason: on the rig's Chromium, `MediaSource.readyState` never leaves
`closed` for `audio/mpeg` (`addSourceBuffer` throws `InvalidStateError`) while
`AudioContext.decodeAudioData` on the same bytes plays fine — so the transport is
decode-as-you-go, which behaves identically in headed and headless browsers.

`stop(reason)`:

1. aborts the fetch (server sees the close and aborts Deepgram),
2. cancels the reader and drops queued chunks,
3. pauses the element and revokes the object URL,
4. records `playedMs` (what the listener actually heard) and `teardownMs`.

Every step lands in `globalThis.__CASTALIA_VOICE_TRACE__`, so timings are read
from the page instead of guessed.

`packages/client/src/coexistir/agentVoice.ts` sequences the plan
(`speakSequence`) so a filler is spoken to completion before the answer starts.

`packages/client/src/coexistir/bargeIn.ts` adds the mic gate: two 50ms frames
above an RMS floor while the agent is speaking → `agentVoice.stop()`. The
`AgentVoiceToggle` panel mounts it, switches the room to `transport='stream'`,
and exposes a `■ Stop` control (`data-testid="agent-voice-stop"`).

## Hermes consult v1 — the documented seam

Every turn is appended to the house log. Default root:

```
~/.hermes/house/coexistir/            (override: COEXISTIR_HOUSE_DIR)
├── turns.jsonl                       turn rows + audio rows (timings, bytes)
├── consult-queue.jsonl               hard questions, status=pending
├── consult-answers.jsonl             Hermes answers, append-only
└── audio/<turnId>.<kind>.mp3         the exact bytes the room played
```

Turn row (one line):

```json
{"event":"turn","turnId":"t_mh3k2_ab12cd","ts":"2026-10-27T18:04:11.512Z",
 "room":"coexistir","voiceKey":"livekit:u123","speaker":"Ana","language":"pt",
 "input":"o que tem na lista hoje?","kind":"hard",
 "filler":"Deixa eu conferir a lista da casa…",
 "reply":"Ana, é assim que a casa está: comprar café e regar as plantas.",
 "needsConsult":false,"model":null,"fallback":false,
 "timings":{"talkerMs":0,"totalMs":14},
 "audio":{"ref":"audio/t_mh3k2_ab12cd.answer.mp3","mime":"audio/mpeg"},
 "reason":"house-list","flags":["house-state"]}
```

Audio row (same file, separate event, written when the stream finishes or is
aborted):

```json
{"event":"audio","turnId":"t_mh3k2_ab12cd","kind":"answer","language":"pt-BR",
 "modelId":"flux-mariana-pt","voiceId":"mariana","bytes":58240,"chunks":31,
 "aborted":false,"timings":{"upstreamMs":210,"headersFlushedMs":212,
 "firstChunkMs":286,"audioTotalMs":1210,"abortMs":null}}
```

Consult row (only for hard turns with **no** data path — no fake synchronous
Hermes anywhere):

```json
{"event":"consult","turnId":"t_mh3k2_zz98ab","ts":"…","room":"coexistir",
 "question":"a porta da frente está trancada?","language":"pt",
 "status":"pending","reason":"open-question","flags":["needs-reasoning"],
 "immediateReply":"Anotei essa pergunta para a casa pensar com calma. …"}
```

### How Hermes drains it

The seam is plain files + three endpoints, so a Hermes profile needs no server
access to read, and one HTTP call to answer:

- `GET /api/coexistir/voice/turns?limit=50` — the same rows as `turns.jsonl`
- `GET /api/coexistir/voice/consult/pending` — unanswered questions
- `POST /api/coexistir/voice/consult/answer` `{turnId, answer, answeredBy}` —
  appends to `consult-answers.jsonl`; the pending list shrinks immediately

A cron/profile prompt that works today (reads the file, answers, posts back):

> Read `~/.hermes/house/coexistir/consult-queue.jsonl`. For each row with no
> matching `turnId` in `consult-answers.jsonl`, answer the question in
> `language` using the house task data. POST each answer to
> `http://localhost:4026/api/coexistir/voice/consult/answer` as
> `{"turnId","answer","answeredBy":"hermes"}`. Do not invent house state; if
> the answer is not knowable, say so.

What is deliberately **not** built: no synchronous call from the room into a
Hermes profile mid-turn. A Hermes profile is an agent runtime (seconds to
minutes); putting it on the audio path would either stall the room or force a
fake "Hermes said" line. The filler + queued consult is the honest version.

## Verifying

```bash
# unit + contract tests
cd packages/server && npx jest modules/voice modules/coexistir/__tests__/reflexTalker.test.ts routes/__tests__/coexistirVoiceRoutes.test.ts
cd packages/client && npx jest src/coexistir

# live timings against the scratch rig (never :4000)
node packages/server/scripts/voice-bridge-verify.mjs \
  --base http://localhost:4026 --out voice-bridge-evidence.json
```

The verifier prints per-step `ttfb` / `ttfc` (time to first chunk), bytes, the
filler→answer gap, the barge-in abort (client + server rows), and the consult
queue drain. Targets: `ttfc < 600ms`, abort acknowledged by the server < 1.5s.
