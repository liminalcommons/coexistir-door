# Voice-ID data contract (server side)

Everything here is **data**, not UI. The door's debug rail owns the pixels; this
file is what the rail can read. All of it is produced from the WAV `/voice/stt`
already receives — no extra upload, no extra request, no extra model.

## Where it lands

| Surface | Shape | Gate |
| --- | --- | --- |
| `POST /api/coexistir/voice/stt` response | `{ voice: {...} }` + `X-Voice-*` headers | public (same as STT) |
| `POST /api/coexistir/voice/turn` response | `{ speaker, speakerSource, claim, voice }` | public |
| `~/.hermes/house/coexistir/turns.jsonl` (`event: 'turn'`) | `speaker`, `speakerSource`, `claim`, `voice` | on disk |
| `~/.hermes/house/coexistir/turns.jsonl` (`event: 'stt'`) | `voice: {...}` beside the transcript | on disk |
| `~/.hermes/house/coexistir/voice-id.jsonl` (`event: 'voice'`) | one `observed` row per clip, one `attached` row per turn | on disk |
| `GET /api/coexistir/voice/id/latest?room=` | live observation + threshold + prints | `?debug=1` |
| `GET /api/coexistir/voice/id/events?limit=` | the `voice-id.jsonl` rows | `?debug=1` |
| `GET /api/coexistir/voice/id/stream?room=` | SSE: `observed`, `claim`, `attached` | `?debug=1` |
| `GET /api/coexistir/voice/health` | `voiceId: { enabled, dims, threshold, enrolled, attachWindowMs }` | public |

`?debug=1` is the same gate the door already uses. Without it the `id/*` reads
answer `403 { error: 'debug_only' }`.

## The turn row fields

```jsonc
{
  "event": "turn",
  "turnId": "t_mvswuzzl_8mvvlp",
  "voiceKey": "owl:spk_07",          // observed voice wins over the kiosk key
  "speaker": "Ana",                  // null unless a claim supplied it
  "speakerSource": "claim",          // 'claim' | 'client' | null
  "claim": {                         // null when no claim exists
    "name": "Ana",
    "status": "verified",            // 'verified' | 'unverified'
    "voiceKey": "owl:spk_07",
    "source": "voice_name_claims"
  },
  "voice": {
    "status": "identified",          // identified | unenrolled | empty | no_audio | disabled | error
    "printId": "vp_08vf0e9",         // stable per voice (session clusters are memory-only)
    "voiceKey": "owl:spk_07",
    "matched": true,                 // above the cosine threshold
    "similarity": 0.957,
    "dims": 52,
    "ms": 19.38,                     // fingerprint CPU time (overlapped with STT)
    "traceId": "v_mvswuzvb_7b8vd",   // the ear's id for this clip
    "ageMs": 25,                     // clip -> turn
    "claimStatus": "resolved",       // none | pending | resolved
    "threshold": 0.82,
    "source": "wav-embedding"
  }
}
```

Rules the rail can rely on:

- `speaker` is **never** inferred from a name the client typed. It comes from
  `voice_name_claims` via the matched voiceKey (`speakerSource: 'claim'`).
- `matched: true` means "matched a print above the cosine threshold" — for a
  stranger it is their own session cluster, so `matched` alone is NOT identity.
  `status` and `voiceKey` are the identity verdict; `similarity` is the score.
- `status: 'identified'` requires an enrolled print **and** a resolved claim.
  A matched-but-unnamed voice is `unenrolled`; a silent/short clip is `empty`;
  a typed turn with no clip behind it is `no_audio`.
- An observation is consumed once. A greeting after a turn cannot inherit the
  previous visitor's name.

## SSE events

`event: voice-id`, one JSON object per line:

```jsonc
{"type":"voice-id","event":"observed","traceId":"v_...","turnId":null,
 "status":"identified","printId":"vp_08vf0e9","voiceKey":"owl:spk_07",
 "matched":true,"similarity":0.957,"claimStatus":"pending","claim":null,
 "speaker":null,"ms":19.38,"dims":52,"durationSec":2.4,"voicedSec":2.192}

{"type":"voice-id","event":"claim","traceId":"v_...","turnId":null,
 "claimStatus":"resolved","claim":{"name":"Ana","status":"verified"},"speaker":"Ana", "...": "..."}

{"type":"voice-id","event":"attached","traceId":"v_...","turnId":"t_...",
 "claimStatus":"resolved","claim":{"name":"Ana","status":"verified"},"speaker":"Ana", "...": "..."}
```

`observed` fires at the end of the ear, `claim` when the name lookup lands,
`attached` when a turn consumes the observation. The stream opens with a
`: voice-id ready dims=52 threshold=0.82` comment and replays the last 20 events.

## Log lines

One line per observation / claim / attach, prefixed `[voice-id]`:

```
[voice-id] observed room=coexistir trace=v_... status=identified print=vp_08vf0e9 matched=1 sim=0.957 dims=52 ms=19.4 voiced=2.19s key=owl:spk_07
[voice-id] claim owl:spk_07 → "Ana" (verified) trace=v_... sim=0.957
[voice-id] attached turn=t_... trace=v_... print=vp_08vf0e9 ageMs=25 speaker=Ana claim=verified
[voice-id] observed room=coexistir trace=v_... status=unenrolled print=vp_1a2b3c4 matched=0 sim=— dims=52 ms=12.1 voiced=1.80s new-cluster
```

## Enrollment and privacy

- Enrolled prints live in `~/.hermes/house/coexistir/voiceprints.json`
  (`{ version: 1, prints: [{ printId, voiceKey, dims, version, vector,
  enrolledAt, source }] }`). Steward-managed; `VoiceprintRegistry.enroll()`
  writes it atomically.
- A stranger's clip **never** touches disk as a voiceprint: it gets a session
  cluster in memory (so their two questions group under one printId) and a
  `voice-id.jsonl` row with `printId` + no name. Nothing is persisted about
  the person's voice.
- Threshold: cosine ≥ 0.82 by default (`COEXISTIR_VOICE_MATCH` overrides).
  `COEXISTIR_VOICE_ID=false` disables the pipeline entirely; the STT response
  then reports `voice.status: 'disabled'` and the turn says `disabled`.

## Exposure note

`GET /voice/turns` is a public read (it always was — it returns the transcript
text too), so the identity fields on those rows are readable by anyone who can
reach the bridge, exactly like `input`/`reply` already were. The rail itself
still only renders with `?debug=1`, and the `id/*` endpoints are 403 without it.
If the owner wants identity to be rail-only on the wire, strip `voice`/`claim`/
`speaker` in `/turns` unless `debug=1` — one line in the handler, no schema
change.

## Correlation seam

The door does not send an id from `/stt` to `/turn`; the turn takes the
freshest unconsumed observation in the same room (20 s window). When that is not
good enough — two kiosks in one room — pass `voiceTraceId` in the `/turn` body
with the `voice.traceId` the ear returned, and the link is exact.
