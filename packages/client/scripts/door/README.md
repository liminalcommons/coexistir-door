# Door regression suite

Behavioural probes for the front-door kiosk (`/portal`). They drive a real
headless Chromium against a running rig, with Chrome's fake capture device fed
from a WAV: the audio path is the production one (getUserMedia → AudioWorklet →
VAD → 16 kHz WAV → `POST /voice/stt` → `POST /voice/turn` → streamed TTS), and
only the microphone is deterministic.

Every probe prints JSON, writes its own evidence JSON + PNG into `--out`, and
**exits non-zero when an assertion fails** — the gate is a pass/fail, not a
score.

```bash
# once: stage the clips (speech clips come from the rig that recorded them)
node make-clips.mjs --clips=./clips --copy-from=<rig folder with door-*.wav>

export NODE_PATH=<repo>/node_modules
node door-modes.mjs  --mode=handsfree --url=http://localhost:4030/portal --clips=./clips
node door-layout.mjs --url=http://localhost:4030/portal
node door-audio-capture.mjs --label=worklet --load=1 --stall=400
```

## door-modes.mjs — the locked behaviour, one mode per clause

| mode | what it asserts (all hard) |
| --- | --- |
| `handsfree` | ONE mic tap ⇒ two complete exchanges; the ear stays open; the state returns to LISTENING by itself after each answer; capture ran on the AudioWorklet with 0 gaps / 0 dropped ms |
| `bargein` | her audio is cut, `bargeIns ≥ 1`, **ParamA → 0 on the cut**, and the interrupting words become the next answered turn |
| `deaf` | mic OFF ⇒ 0 STT requests, 0 turns; state stays MIC DESLIGADO |
| `silence` | 40 s of quiet ⇒ 0 STT, 0 turns, no caption change, state never leaves LISTENING |
| `cutoff` | mic OFF mid-capture ⇒ the half-spoken clip is never uploaded; the ear handle is gone |
| `pause-short` | a pause under the VAD timer ⇒ one question, one turn |
| `pause-long` | a pause over the timer ⇒ still one turn: the continuation is merged, not answered twice |
| `gated` | public `/portal` has no rail, no voiceKey, no transcript words; `?debug=1` has the rail with Voice-ID → transcript → event log |

`pause-short` and `pause-long` read the RAIL's transcript, so run them with
`--debug=1` (the rail renders at any width when debug is on, so a 480x960 viewport
is fine).

## door-layout.mjs — the shapes the owner sees

2560×1440, 1366×768, 390×844; each loaded public and `?debug=1`. Asserts: no
console/page errors, no dialogs, nothing off-screen, dock on screen and never
over the stage, canvas backing store == min(dpr, 2), framing applied, rail only
where it is allowed. Writes one PNG per shape.

## door-panels.mjs — the debug panels and the WHOLE Live2D map

Loads the door at 1440×900 (`?debug=1`) and 390×844, and asserts:

- the desktop rail carries VOICE ID → LIVE2D triggers → TRANSCRIPT → EVENT LOG,
  with the identity rows that exist (speaker claim, voiceKey, claim state and
  quorum) **and** the rows that say what does NOT exist (`voiceprint: not
  computed`, `confidence: unknown`) — no invented score, ever;
- with `--clips` the fake microphone produces real turns, so the transcript has
  both speakers and the log has TURN/STT/TTS rows with measured timings;
- at 390px the rail is gone and the drawer's VOZ / EVENTOS / TRANSCRIÇÃO panes
  carry the same data;
- every state in `AGENT_STATE_MAP` fires through the door's own path
  (`__portalRig.applyCue` / `applyState`), the rig's current motion + expression
  equal the map's, `applied=false` is a failure, and every trigger printed one
  `[live2d:trigger]` console line naming the motion file and expression.

```bash
node door-panels.mjs --url="http://localhost:4030/portal?debug=1&lang=pt" \
  --clips=./clips --out=./out
```

The clip it feeds is `door-pt-en.wav` (a PT question, silence, then an EN
question) so one run proves both speakers and both languages; override it with
`--clip=<name>`.

`--url` may carry a query string; only the first `=` separates the flag from its
value (splitting on every `=` silently turns `?debug=1` into `?debug`).

## door-audio-capture.mjs — main-thread starvation

Generates a 30 s ramp WAV (amplitude = position in the clip), loads the door at
2560×1440, opens the ear, then burns the main thread (`--load=1`) and/or blocks
it once (`--stall=400`). Reports, for the capture path the build actually uses:

- `gaps` / `maxGapMs` — holes in the audio timeline the VAD saw;
- `maxDeficitMs` — the window in which the page had no frames at all;
- `droppedMs` — audio the tap produced that never reached the page;
- `lateMs` — how stale the newest block was when the page processed it;
- `drift` — seconds of clip consumed vs seconds elapsed (skipped audio shows here).
