/**
 * PortalPage — Mara's always-on, portrait front door.
 *
 * Layout is the owner's lock: ONE 9:16 page, no tabs, no scroll —
 *   topbar · square Live2D stage · voice-ID debug · one caption · mic/cam dock.
 *
 * Speech is ALWAYS-ON (owner, 2026-10-28, locked):
 *   - Tapping MIC opens the ear. It STAYS open. There is no send button, no
 *     tap-to-stop, and no timeout: after every answer she is listening again,
 *     untouched. Tapping MIC again closes it — and a closed mic is deaf, it
 *     neither records nor sends.
 *   - VAD ends the utterance. ~1.2 s of silence after the last voiced frame
 *     closes the clip and ships it (portalVad.ts owns the detector and the
 *     timings; this file owns the conversation).
 *   - Barge-in: speaking over her cuts her off and takes the floor. The same
 *     detector sees the interruption at a higher bar, aborts playback AND the
 *     upstream stream, and keeps the interrupting words as the next question.
 *
 * One spoken turn, end to end:
 *   1. VAD -> 16 kHz mono WAV segment (pre-roll included) ->
 *   2. `POST /voice/stt`, where Deepgram transcribes it (the key stays server-side);
 *   3. the transcript goes into the UNCHANGED `POST /voice/turn` bridge —
 *      detection, honest filler, task answer and the consult queue behave
 *      exactly as they did for typed text;
 *   4. the answer streams back through the progressive player and drives the
 *      Live2D mouth (agentVoice / realtimeVoice untouched).
 *
 * The answer language follows the VOICE, not the URL: STT auto-detects, so an
 * English question at a Portuguese kiosk is answered in English. `?lang=` only
 * picks the door's own speaking language for the greeting.
 *
 * The debug surfaces tell the truth about that chain: what was heard, how long
 * the ear took (`sttMs`), how long the turn took, the end-of-speech to
 * first-audio budget, the VAD's measured floor/threshold, WHO the bridge thinks
 * spoke (claim name + claim state, with "no voiceprint" stated instead of a fake
 * confidence), and one line per Live2D state change.
 *
 * Debug surfaces render on a plain `/portal` (owner order, Oct 2026): the rail
 * is what the door shows, open, with an X that hides it for the session. What a
 * public screen must never leak is handled by the session boundary, not by
 * hiding the panels: the rail only ever reads the CURRENT session, and a
 * boundary clears transcript/heard/timings while the mic stays on.
 *   desktop  https://door.castalia.one/portal                  → stage + right rail
 *   desktop  https://door.castalia.one/portal?debug=1          → same, forced past a dismissal
 *   portrait https://door.castalia.one/portal                  → debug card + drawer
 *   rig      http://localhost:4030/portal?debug=1
 *   a shorter session boundary for probes: `?debug=1&idle=12000`
 * The rail carries VOICE ID → LIVE2D triggers → TRANSCRIPT → EVENT LOG; the
 * portrait drawer carries the same three panes (VOZ / EVENTOS / TRANSCRIÇÃO).
 *
 * A failed endpoint renders as unavailable; nothing is invented, including the
 * "confidence" number the mockup had (no speaker-embedding stage exists, so the
 * panel prints "unknown" and says why).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentVoice } from '../coexistir/agentVoice';
import { readVoiceTrace } from '../coexistir/realtimeVoice';
import { PortalStage, type PortalRigTelemetry, type PortalStageHandle } from './PortalStage';
import {
  claimVoiceName,
  fetchManagerTurn,
  fetchTtsProfile,
  fetchVoiceEvents,
  fetchVoiceHealth,
  fetchVoiceIdentity,
  fetchVoiceTurn,
  fetchVoiceTurns,
  inferVoiceIntent,
  listVoiceClaims,
  newestFirst,
  resolveClaimantLabel,
  resolveKioskVoiceKey,
  transcribeUtterance,
  type AcousticSnapshot,
  type ManagerIntent,
  type PortalLanguage,
  type SttResult,
  type TtsProfile,
  type VoiceAudioRow,
  type VoiceClaim,
  type VoiceEventRow,
  type VoiceHealth,
  type VoiceIdentity,
  type VoiceTurnRow,
} from './portalApi';
import './PortalPage.css';
import { DockIcon } from './PortalIcons';
import { DOOR_COPY, doorStateOf, type DoorState } from './doorState';
import { MAX_MERGES, continuationGap, mergeTranscripts } from './continuation';
import { createPortalVad, encodeWav, VAD_DEFAULTS, type PortalVadHandle, type PortalVadSnapshot } from './portalVad';
import { StageTriggerPanel, VoiceIdPanel } from './VoiceIdPanel';
import { VoiceEnrollPanel } from './VoiceEnrollPanel';
import { readTriggers, subscribeTriggers, type TriggerRecord } from '../live2d/stageTriggers';
import { createPortalSttStream, type PortalSttStreamHandle, type SttStreamTurnEvent } from './portalSttStream';
import {
  dbfsText,
  earNotice,
  earVerdictOf,
  type EarVerdict,
  type MicErrorKind,
} from './earState';
import {
  DoorTurnTimings,
  recentDoorTimings,
  type DoorTimingRow,
  type TimingBaseSource,
} from './doorTimings';

/**
 * The build id vite bakes in (`define` in vite.config.ts — the same value that
 * brands sw.js and build-id.txt). Printed on the root as `data-build` so a
 * screenshot says WHICH bundle rendered it: "the rail is missing" and "the
 * browser is still on an old bundle" look identical otherwise.
 */
declare const __BUILD_ID__: string;
const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

type CaptionKind = 'greeting' | 'filler' | 'answer' | 'status';

/**
 * The door has exactly ONE state, and every readout is derived from it: the
 * stage tag, the state line in the dock, and the mic button all read the same
 * `DoorState`. That is the fix for the owner's screenshot, where the tag said
 * IDLE, the caption said "Pode falar" and the dock offered STOP at the same
 * time — three widgets, three opinions, no truth.
 *
 * `doorState.ts` owns the union and the words; this file owns the facts that
 * feed it (`micOn`, `speaking`, `thinking`). The mic button is NOT state-shaped:
 * it is a toggle, and it never turns into a send/stop/interrupt control.
 */

interface DebugSnapshot {
  claims: VoiceClaim[];
  profile: TtsProfile | null;
  health: VoiceHealth | null;
  events: VoiceEventRow[];
  turns: VoiceTurnRow[];
  /** Live identity for the pinned voice key (claims, quorum, no voiceprint). */
  identity: VoiceIdentity | null;
  errors: {
    claims?: string;
    profile?: string;
    health?: string;
    events?: string;
    turns?: string;
    identity?: string;
  };
}

interface ClientTraceSnapshot {
  firstChunkMs?: number;
  audioStartMs?: number;
  stopPlayedMs?: number;
  stopTeardownMs?: number;
}

interface EarTimings {
  /** Server-side: upload received -> transcript in hand. */
  sttMs?: number;
  /** End of speech -> the recorder Blob is complete (local capture flush). */
  blobMs?: number;
  /** End of speech -> first audio scheduled (filler included). */
  ttfaMs?: number;
  /** End of speech -> first ANSWER audio (what the question actually cost). */
  answerTtfaMs?: number;
  /** `POST /voice/turn` handler time. */
  turnMs?: number;
  /** Which ear produced the transcript: provider streaming, or a posted clip. */
  sttPath?: 'stream' | 'batch';
  /** Provider endpointing window (ms) in force this turn, when streaming. */
  endpointingMs?: number;
  /** Which provider signal ended the turn (streaming only). */
  closedBy?: 'speech_final' | 'utterance_end';
}

interface TurnTrace {
  turnId: string;
  kind: string;
  resolvedFrom: string;
  needsConsult: boolean;
  language?: string;
  intent?: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the VISITOR reads when a call fails. A raw `429 Too Many Requests` on a
 * public door is both cryptic and the one failure that resolves itself: the
 * server's general API limiter is shared by every poll the door makes, so the
 * honest instruction is to wait a moment, not to reload or re-allow the mic.
 */
function doorErrorCopy(message: string, language: 'pt' | 'en'): string {
  if (/\b429\b/.test(message) || /too many requests/i.test(message)) {
    return language === 'pt'
      ? 'O servidor está limitando pedidos agora — aguarde alguns segundos e fale de novo.'
      : 'The server is rate-limiting requests — wait a few seconds and speak again.';
  }
  return message;
}

function snapshotTrace(): ClientTraceSnapshot {
  const reversed = [...readVoiceTrace()].reverse();
  const first = reversed.find((e) => e.kind === 'first-chunk');
  const started = reversed.find((e) => e.kind === 'audio-start');
  const stopped = reversed.find((e) => e.kind === 'stop');
  return {
    firstChunkMs: typeof first?.elapsedMs === 'number' ? first.elapsedMs : undefined,
    audioStartMs: typeof started?.elapsedMs === 'number' ? started.elapsedMs : undefined,
    stopPlayedMs: typeof stopped?.playedMs === 'number' ? Number(stopped.playedMs) : undefined,
    stopTeardownMs: typeof stopped?.teardownMs === 'number' ? Number(stopped.teardownMs) : undefined,
  };
}

/**
 * `performance.now()` of the first `audio-start` trace event recorded after
 * `mark`. That instant is when the player scheduled the first buffer, i.e. the
 * moment the visitor's wait ends.
 */
function firstAudioAfter(mark: number): number | null {
  const trace = readVoiceTrace();
  for (let i = mark; i < trace.length; i += 1) {
    const event = trace[i];
    if (event.kind === 'audio-start' && typeof event.t === 'number') return event.t;
  }
  return null;
}

// --- the drawer: event log + transcript ------------------------------------

/** Enough rows to see several turns; the endpoint caps at 400. */
const LOG_LIMIT = 120;

/**
 * Session boundary (review #8/#9). A front-door screen is public: the next
 * visitor must not read the previous visitor's words, and the transcript must
 * show the CURRENT session only. After this much quiet — no speech, nothing in
 * flight — the session is closed silently: rail and transcript clear, the mic is
 * untouched, and the greeting is composed again (as text; entry is silent).
 *
 * `?debug=1&idle=<ms>` shortens it FOR RIGS (the boundary is otherwise three
 * minutes of silence, which no automated probe wants to wait for). The public
 * door has no such parameter: without `debug=1` this constant is the rule.
 */
const SESSION_IDLE_MS = 3 * 60 * 1000;
const SESSION_IDLE_MIN_MS = 3000;

/**
 * Where the rail remembers that it was closed (owner order, Oct 2026: the rail
 * is OPEN on arrival, and one tap hides it). Session-scoped on purpose — a new
 * tab starts with the rail open again, so a locked kiosk can never be left in a
 * state the next owner cannot see.
 */
const DEBUG_RAIL_STORAGE_KEY = 'castalia.portal.debugRail';

function sessionIdleMs(search: string, forced: boolean): number {
  // Keyed on the FORCED flag, not on "surfaces are on": the short boundary is a
  // rig convenience, and the public door must keep the full three minutes.
  if (!forced) return SESSION_IDLE_MS;
  const value = Number(new URLSearchParams(search).get('idle'));
  return Number.isFinite(value) && value >= SESSION_IDLE_MIN_MS ? value : SESSION_IDLE_MS;
}

function clockOf(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return '--:--:--';
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function msText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : '—';
}

interface LogRow {
  key: string;
  ts: string;
  kind: 'TURN' | 'STT' | 'TTS' | 'CONSULT' | 'ANSWER' | 'EAR' | 'MIC' | 'ID';
  head: string;
  meta: string;
  body: string;
  /** Measured in the page, not read from the server log. */
  local?: boolean;
}

/**
 * One log row per event, in the log's own words. Timings are printed only
 * where the server actually measured them — a missing number stays `—` instead
 * of being rounded into a nicer-looking lie.
 */
function describeEvent(row: VoiceEventRow, index: number): LogRow {
  const key = `${row.ts}-${row.event}-${index}`;
  if (row.event === 'turn') {
    return {
      key,
      ts: row.ts,
      kind: 'TURN',
      head: `${row.kind} · ${row.needsConsult ? 'consult' : row.resolvedFrom ?? 'answered'} · ${(row.language || '—').toUpperCase()}`,
      meta: `talker ${msText(row.timings?.talkerMs)} · total ${msText(row.timings?.totalMs)}${row.model ? ` · ${row.model}` : ''}`,
      body: `“${row.input}” → ${row.reply}`,
    };
  }
  if (row.event === 'stt') {
    return {
      key,
      ts: row.ts,
      kind: 'STT',
      head: `${msText(row.sttMs)} · net ${msText(row.providerMs)} · ${(row.detectedLanguage ?? row.language ?? '—').toUpperCase()}`,
      meta: `${row.model ?? '—'} · ${row.bytes ?? 0} B${typeof row.confidence === 'number' ? ` · conf ${row.confidence.toFixed(2)}` : ''}`,
      body: row.ok ? `“${row.text}”` : `falhou · ${row.reason ?? 'sem texto'}`,
    };
  }
  if (row.event === 'audio') {
    return {
      key,
      ts: row.ts,
      kind: 'TTS',
      head: `${row.kind} · 1º chunk ${msText(row.timings?.firstChunkMs)} · ${row.bytes} B`,
      meta: `${row.voiceId} · ${row.modelId} · ${row.chunks} chunks${row.aborted ? ' · abortado' : ''}`,
      body: '',
    };
  }
  if (row.event === 'consult') {
    return {
      key,
      ts: row.ts,
      kind: 'CONSULT',
      head: `${row.status} · ${(row.language || '—').toUpperCase()}${row.flags?.length ? ` · ${row.flags.join(',')}` : ''}`,
      meta: row.reason ?? row.turnId,
      body: row.question,
    };
  }
  return {
    key,
    ts: row.ts,
    kind: 'ANSWER',
    head: `por ${row.answeredBy ?? 'hermes'} · ${(row.language ?? '—').toUpperCase()}`,
    meta: row.turnId,
    body: row.answer,
  };
}

interface TranscriptLine {
  key: string;
  ts: string;
  role: 'visitor' | 'mara';
  who: string;
  language: string;
  text: string;
}

/**
 * The transcript is the house log read as a script: every `turn` row carries
 * the visitor's words and Mara's reply, and a clip that was heard but never
 * answered (a failed turn) still appears from its `stt` row. Nothing is
 * generated here — if the log is empty, the drawer says so.
 */
function buildTranscript(events: VoiceEventRow[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const answered = new Set<string>();
  for (const row of events) {
    if (row.event !== 'turn') continue;
    const language = (row.language || '—').toUpperCase();
    if (row.input?.trim()) {
      lines.push({ key: `${row.turnId}-visitor`, ts: row.ts, role: 'visitor', who: 'VOCÊ', language, text: row.input });
      answered.add(row.input.trim().toLowerCase());
    }
    if (row.reply?.trim()) {
      lines.push({ key: `${row.turnId}-mara`, ts: row.ts, role: 'mara', who: 'MARA', language, text: row.reply });
    }
  }
  for (const row of events) {
    if (row.event !== 'stt' || row.ok === false || !row.text?.trim()) continue;
    const text = row.text.trim();
    if (answered.has(text.toLowerCase())) continue;
    lines.push({
      key: `stt-${row.ts}`,
      ts: row.ts,
      role: 'visitor',
      who: 'VOCÊ',
      language: (row.detectedLanguage ?? row.language ?? '—').toUpperCase(),
      text,
    });
  }
  return lines.sort((a, b) => a.ts.localeCompare(b.ts));
}

declare global {
  interface Window {
    __portalVoice?: typeof agentVoice;
    /** The always-on ear, exposed for the rig's proof (and for the owner). */
    __portalVad?: PortalVadHandle;
  }
}

const PortalPage: React.FC = () => {
  const stageRef = useRef<PortalStageHandle | null>(null);
  const runRef = useRef(0);
  const bootedRef = useRef(false);
  /** The always-on ear. Non-null for the whole time the mic is ON. */
  const vadRef = useRef<PortalVadHandle | null>(null);
  /**
   * Mirrors `micActive` for callbacks that the audio graph captured at start
   * time: a VAD onset must know whether the door still intends to be listening.
   */
  const listeningRef = useRef(false);
  const camStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const currentTextRef = useRef('');
  /**
   * Entry is silent (owner's rule): the player stays mute until the visitor has
   * actually said something. Set on the first captured utterance, checked in
   * `speakStep`, so no code path can greet the room with a voice.
   */
  const audioAllowedRef = useRef(false);
  /**
   * The last clip that was auto-sent, kept for `CONTINUATION_MS` so a mid-sentence
   * pause can be re-sent as ONE question instead of two wrong ones.
   */
  const lastSendRef = useRef<{
    sentAt: number;
    endAtMs: number;
    /** Batch clips: the PCM parts, so two clips can be re-sent as one. */
    parts?: Float32Array[];
    sampleRate: number;
    merges: number;
    /**
     * Streaming turns: the text that was answered. A stream has no clip to
     * re-send, so a continuation joins the WORDS instead (see
     * `mergeTranscripts`) — same question, no second Deepgram call.
     */
    text?: string;
    /** Set when a barge-in cut her inside the continuation window. */
    cutAt?: number;
  } | null>(null);
  /** Wall time of the last speech, for the idle session boundary. */
  const lastSpeechAtRef = useRef(0);
  /** Mirrors of the last STT/turn for callbacks created once per mic-on. */
  const sttRef = useRef<string>('');
  const turnIdRef = useRef<string | null>(null);
  /**
   * The streaming ear. ONE socket per MIC-ON (never per turn): it is opened
   * while the visitor is still speaking, so end-of-turn is the provider's
   * endpointing rather than a local silence timer. `null` means the door is on
   * the batch path — a state the rail prints, so a degraded door is visible.
   */
  const streamRef = useRef<PortalSttStreamHandle | null>(null);
  /**
   * The stream ONLY while it is ready and healthy. `streamRef` is the handle to
   * talk to (it exists during the handshake too); this is the "the provider is
   * really hearing us" flag the VAD consults before it decides whether its own
   * clip is redundant.
   */
  const streamGuard = useRef<PortalSttStreamHandle | null>(null);
  /**
   * Stream turn count when the CURRENT utterance began. The VAD's own
   * end-of-speech lands ~1200 ms after the last voiced frame, the provider's
   * endpointing at ~500 ms — so by the time the VAD clips the utterance the
   * stream has ALREADY answered it, and a baseline read at that moment hides
   * the turn. The watchdog then re-posted every clip (two STT calls and two
   * turn rows per question). The baseline belongs to the onset.
   */
  const streamTurnsAtSpeechRef = useRef(0);
  const [sttPath, setSttPath] = useState<'stream' | 'batch'>('batch');
  const [streamState, setStreamState] = useState<{
    ready: boolean;
    endpointing: number | null;
    utteranceEndMs: number | null;
    audioMs: number;
    turns: number;
    /** Blocks captured while the relay was not ready: audio that never left. */
    unsentBlocks?: number;
  } | null>(null);
  /** The waterfall rows (newest last), for the debug rail. */
  const [timingRows, setTimingRows] = useState<DoorTimingRow[]>([]);
  /** Start of the current session, in ms since epoch. The rail never shows older rows. */
  const sessionStartRef = useRef(Date.now());

  /**
   * `?debug=1` (or true/on/yes) is the OWNER'S FORCE FLAG: a door opened with it
   * always shows the debug surfaces, even after a previous close and even when
   * the tab remembers a dismissal. A link that travelled through a chat client
   * or a bookmark must not silently become a clean door — a dropped flag is
   * indistinguishable from a lost rail.
   */
  const debugForced = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const flag = new URLSearchParams(window.location.search).get('debug');
    if (flag === null) return false;
    return ['1', 'true', 'on', 'yes'].includes(flag.trim().toLowerCase());
  }, []);

  /**
   * The debug rail (VOICE ID → LIVE2D → TRANSCRIPT → EVENT LOG) is OPEN on
   * arrival on a plain `/portal` (owner order, Oct 2026: the panels must be
   * there without a query string). That deliberately overrides the earlier
   * privacy default of "surfaces only with `?debug=1`", and the mitigation is
   * two things, both true here:
   *
   *   (a) the rail shows the CURRENT session only — `sessionLog` drops every row
   *       older than `sessionStartRef`, and a session boundary clears what a
   *       public screen could leak (see `closeSession`), so a bystander cannot
   *       read a previous visitor's words;
   *   (b) ONE TAP closes it — the X in the rail head stores the dismissal for
   *       the session, and a reload stays closed for as long as this tab lives.
   *
   * `?debug=1` wins over that memory: the owner's URL must always be able to
   * prove the panels, otherwise a closed tab reads as a broken build.
   */
  const [debugOn, setDebugOn] = useState<boolean>(() => {
    if (debugForced) return true;
    if (typeof window === 'undefined') return true;
    try {
      return window.sessionStorage.getItem(DEBUG_RAIL_STORAGE_KEY) !== 'closed';
    } catch {
      // Private mode / storage disabled: the rail opens, and the X still hides
      // it for this page. A missing storage must never blank the door.
      return true;
    }
  });

  const [voiceKey] = useState<string>(() => resolveKioskVoiceKey());
  const [language] = useState<PortalLanguage>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    return fromUrl === 'en' ? 'en' : 'pt';
  });
  const [caption, setCaption] = useState('');
  const [captionKind, setCaptionKind] = useState<CaptionKind>('status');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState(agentVoice.snapshot);
  const [debug, setDebug] = useState<DebugSnapshot>({
    claims: [],
    profile: null,
    health: null,
    events: [],
    turns: [],
    identity: null,
    errors: {},
  });
  const [rig, setRig] = useState<PortalRigTelemetry | null>(null);
  /** The last clip's measured acoustics (never a voiceprint — see VoiceIdPanel). */
  const [acoustic, setAcoustic] = useState<AcousticSnapshot | null>(null);
  /** The Live2D trigger log: the same lines the console prints, live. */
  const [triggers, setTriggers] = useState<TriggerRecord[]>([]);
  const [trace, setTrace] = useState<ClientTraceSnapshot>({});
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  /**
   * Live input RMS from the SAME frame as `micLevel`. The EQ bars alone cannot
   * tell a quiet-but-working mic from a dead one; the number can.
   */
  const [micRms, setMicRms] = useState<number | null>(null);
  /** What the browser says about the microphone permission, live. */
  const [micPerm, setMicPerm] = useState<'unknown' | 'granted' | 'prompt' | 'denied'>('unknown');
  /** Why getUserMedia failed, if it did — the reason, not just "mic off". */
  const [micProblem, setMicProblem] = useState<{ kind: MicErrorKind; message: string; name?: string } | null>(null);
  /** The honest verdict on the open ear: idle / ok / no-frames / silent / below-bar. */
  const [earVerdict, setEarVerdict] = useState<EarVerdict>('idle');
  /**
   * Measurements taken in the PAGE (permissions, getUserMedia failures, live
   * level, onset attempts). They are merged into the rail's EVENTOS pane and
   * survive a failed server call, because the console is not a proof surface.
   */
  const [localLog, setLocalLog] = useState<LogRow[]>([]);
  /** Audio-time (page clock) the ear opened, for the warm-up window. */
  const earOpenedAtRef = useRef<number | null>(null);
  /**
   * The permission as of THIS frame, readable from callbacks created earlier
   * (the getUserMedia failure handler must not read a stale 'unknown').
   */
  const micPermRef = useRef<'unknown' | 'granted' | 'prompt' | 'denied'>('unknown');
  /** Mara's real output level, polled only while she speaks (state-line meter). */
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  /** Local VAD counters, printed in the debug strip. Measurements, not vibes. */
  const [vad, setVad] = useState<PortalVadSnapshot | null>(null);
  const [earBusy, setEarBusy] = useState<'idle' | 'transcribing'>('idle');
  const [stt, setStt] = useState<SttResult | null>(null);
  const [sttError, setSttError] = useState<string | null>(null);
  const [timings, setTimings] = useState<EarTimings>({});
  const [turnTrace, setTurnTrace] = useState<TurnTrace | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  /** Closed, or open on one of the three panes. The drawer overlays; it never reflows the door. */
  const [drawer, setDrawer] = useState<'closed' | 'voice' | 'log' | 'transcript'>('closed');

  /**
   * One tap on the rail's X: hide every debug surface for the rest of the
   * session (and close the drawer if it was open). The dismissal is remembered
   * in `sessionStorage`, so a reload inside the same tab does not put the rail
   * back; `?debug=1` still forces it, so the owner can always re-prove it.
   */
  const closeDebugRail = useCallback(() => {
    setDebugOn(false);
    setDrawer('closed');
    try {
      window.sessionStorage.setItem(DEBUG_RAIL_STORAGE_KEY, 'closed');
    } catch {
      /* storage unavailable (private mode): the close still applies to this page */
    }
  }, []);
  const [log, setLog] = useState<VoiceEventRow[]>([]);
  const [logAt, setLogAt] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  /**
   * One row of evidence measured in the PAGE. The rail used to be a mirror of
   * the server's event log, so the failures that happen BEFORE a request exists
   * (permission denied, a capture that delivers nothing, a VAD that never
   * fires) left no trace anywhere but the console. Bounded, because this feeds
   * a public kiosk's rail, not a log file.
   */
  const logLocal = useCallback(
    (kind: LogRow['kind'], head: string, body = '', meta = '') => {
      setLocalLog((rows) =>
        [
          {
            key: `local-${Date.now()}-${rows.length}`,
            ts: new Date().toISOString(),
            kind,
            head,
            meta,
            body,
            local: true,
          },
          ...rows,
        ].slice(0, 30),
      );
    },
    [],
  );

  /**
   * The permission ITSELF, not just its consequences: "granted / prompt /
   * denied" is readable without a prompt in Chromium and asks nothing of the
   * visitor. Browsers that do not expose it stay at 'unknown', which is honest.
   */
  useEffect(() => {
    let cancelled = false;
    const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
    if (!perms?.query) return;
    perms
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (cancelled) return;
        setMicPerm(status.state as 'granted' | 'prompt' | 'denied');
        status.onchange = () =>
          setMicPerm(status.state as 'granted' | 'prompt' | 'denied');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (micPerm === 'unknown') return;
    micPermRef.current = micPerm;
    logLocal(
      'MIC',
      `permissão do microfone · ${micPerm}`,
      micPerm === 'denied'
        ? 'o navegador bloqueia o microfone para este endereço'
        : micPerm === 'prompt'
          ? 'o navegador vai perguntar ao abrir o microfone'
          : 'o navegador já autorizou este endereço',
    );
  }, [micPerm, logLocal]);

  /**
   * The ear's own tick. Every second it reads the REAL counters and decides
   * which of the four "it says OUVINDO but nothing happens" faults is true —
   * so the door can say it instead of waiting forever in silence. It also
   * keeps the debug rows live: a number that only updates on a turn cannot
   * diagnose a turn that never happens.
   */
  useEffect(() => {
    if (!micActive) {
      setEarVerdict('idle');
      setMicRms(null);
      return;
    }
    let ticks = 0;
    const tick = () => {
      const snap = vadRef.current?.snapshot();
      if (!snap) return;
      ticks += 1;
      setVad(snap);
      const opened = earOpenedAtRef.current ?? performance.now();
      const verdict = earVerdictOf({
        blocks: snap.blocks,
        maxRms: snap.maxRms,
        onsets: snap.onsets,
        threshold: snap.threshold,
        listeningMs: performance.now() - opened,
      });
      setEarVerdict((prev) => {
        if (prev === verdict) return prev;
        if (verdict === 'silent') {
          logLocal(
            'EAR',
            'sem áudio audível na captura',
            `pico ${dbfsText(snap.maxRms)} · ${snap.blocks} blocos · bar ${dbfsText(snap.threshold)} · ${snap.deviceLabel || 'dispositivo sem nome'}`,
          );
        } else if (verdict === 'no-frames') {
          logLocal(
            'MIC',
            'captura aberta sem nenhum bloco de áudio',
            'o AudioContext não está entregando quadros (contexto suspenso ou dispositivo parado)',
          );
        } else if (verdict === 'below-bar' && prev !== 'below-bar') {
          logLocal(
            'EAR',
            'áudio chega, mas o portão de fala não abre',
            `pico ${dbfsText(snap.maxRms)} < bar ${dbfsText(snap.threshold)} · ${snap.barHits} quadros no limiar`,
          );
        }
        return verdict;
      });
      // A periodic measurement while the ear is NOT hearing anything: the
      // onset attempts and the floor/bar, every five seconds, in the log.
      if (verdict !== 'ok' && verdict !== 'idle' && ticks % 5 === 0) {
        logLocal(
          'EAR',
          `${snap.barHits} tentativa(s) de fala · bar ${dbfsText(snap.threshold)}`,
          `pico ${dbfsText(snap.maxRms)} · piso ${dbfsText(snap.noiseFloor)} · ${snap.blocks} blocos · ${snap.mode} ${snap.sampleRate} Hz`,
          `${verdict}`,
        );
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [micActive, logLocal]);
  /** Bumped on every barge-in; the stage shuts ParamA on the frame it changes. */
  const [cutAt, setCutAt] = useState(0);
  /** Which session the rail is showing, and why the previous one ended. */
  const [session, setSession] = useState(0);
  const [sessionBoundary, setSessionBoundary] = useState<string>('');
  const [merges, setMerges] = useState(0);
  /**
   * Turns that were cancelled by a continuation merge: they are still in the
   * house log (the log is a log), but the TRANSCRIPT must not show an answer the
   * visitor never actually got — the merged question is the one that was asked.
   */
  const [mergedAway, setMergedAway] = useState<Array<{ turnId?: string; text?: string }>>([]);
  /**
   * Clips the ear heard but STT returned nothing for (review #12). They never
   * become a turn, and the count is shown so a noisy room is visible instead of
   * silently paying for empty Deepgram calls.
   */
  const [emptyStt, setEmptyStt] = useState(0);
  const drawerBodyRef = useRef<HTMLDivElement | null>(null);

  const speaking = voiceState.phase === 'speaking';
  const blocked = voiceState.phase === 'blocked' || (error ?? '').includes('blocked');
  const busy = thinking || earBusy === 'transcribing';
  /** Mirror for callbacks/timers that must not re-subscribe on every render. */
  const busyRef = useRef(false);
  busyRef.current = busy;

  /**
   * The single source of truth, derived in `doorStateOf` from three facts:
   * the mic toggle, whether she is audible, whether a turn is in flight.
   *   speaking > deaf > thinking > listening
   * The readout cannot disagree with the dock because both print `copy.label`
   * and the mic button is a toggle, not a state-shaped action.
   */
  const doorState: DoorState = doorStateOf({ micOn: micActive, speaking, thinking: busy });
  const copy = DOOR_COPY[language][doorState];
  /**
   * The ear's honest verdict, in plain words. Permission failures and a capture
   * that delivers nothing are shown ABOVE the dock, not only in the rail: the
   * visitor standing at the door is the one who has to fix it.
   */
  const earIssue =
    micActive || micProblem ? earNotice(earVerdict, language, micProblem?.kind ?? null) : null;
  const stateHint = earIssue ? earIssue.title : copy.hint;
  const meterLevel = doorState === 'listening' ? micLevel : doorState === 'speaking' ? voiceLevel : 0;
  const meterLit = Math.round(Math.min(1, Math.max(0, meterLevel)) * 9);
  const micDbText = micActive && micRms !== null ? dbfsText(micRms) : '—';

  const refreshDebug = useCallback(async () => {
    const [claims, profile, health, events, turns, identity] = await Promise.allSettled([
      listVoiceClaims(voiceKey),
      fetchTtsProfile(),
      fetchVoiceHealth(),
      fetchVoiceEvents(40),
      fetchVoiceTurns(3),
      fetchVoiceIdentity(voiceKey),
    ]);
    setDebug((prev) => ({
      claims: claims.status === 'fulfilled' ? claims.value : prev.claims,
      profile: profile.status === 'fulfilled' ? profile.value : prev.profile,
      health: health.status === 'fulfilled' ? health.value : prev.health,
      events: events.status === 'fulfilled' ? events.value : prev.events,
      turns: turns.status === 'fulfilled' ? turns.value : prev.turns,
      identity: identity.status === 'fulfilled' ? identity.value ?? prev.identity : prev.identity,
      errors: {
        claims: claims.status === 'rejected' ? messageOf(claims.reason) : undefined,
        profile: profile.status === 'rejected' ? messageOf(profile.reason) : undefined,
        health: health.status === 'rejected' ? messageOf(health.reason) : undefined,
        events: events.status === 'rejected' ? messageOf(events.reason) : undefined,
        turns: turns.status === 'rejected' ? messageOf(turns.reason) : undefined,
        identity: identity.status === 'rejected' ? messageOf(identity.reason) : undefined,
      },
    }));
  }, [voiceKey]);

  /**
   * File a name claim for the voice this door is pinned to — the SAME endpoint
   * and the SAME quorum the meeting tiles use (`voice_name_claims`). One visitor
   * naming a voice is a claim, never an identity; a second distinct visitor (or a
   * steward) is what makes it "verified", and then the speaker row above shows
   * the name because the identity read reads the claims.
   */
  const claimThisVoice = useCallback(
    async (claimedName: string) => {
      const filed = await claimVoiceName({
        voiceKey,
        claimedName,
        claimBy: resolveClaimantLabel(),
      });
      logLocal(
        'ID',
        filed.status === 'verified'
          ? `voz verificada · “${filed.claim.claimedName}”`
          : `nome registrado · “${filed.claim.claimedName}” · falta 1 nome`,
        `claimBy ${filed.claim.claimBy} · voiceKey ${voiceKey}`,
        filed.status,
      );
      // Read the claims back immediately: the panel must show what is stored,
      // not what the POST happened to answer.
      void refreshDebug();
      return { status: filed.status, name: filed.claim.claimedName };
    },
    [voiceKey, refreshDebug, logLocal],
  );

  useEffect(() => {
    document.documentElement.classList.add('portal-body');
    document.body.classList.add('portal-body');
    agentVoice.setTransport('stream');
    agentVoice.setEnabled(true, { persist: false });
    window.__portalVoice = agentVoice;
    const unsubscribe = agentVoice.subscribe(setVoiceState);
    const unsubscribeTriggers = subscribeTriggers(setTriggers);
    setTriggers(readTriggers());
    return () => {
      document.documentElement.classList.remove('portal-body');
      document.body.classList.remove('portal-body');
      delete window.__portalVoice;
      unsubscribe();
      unsubscribeTriggers();
    };
  }, []);

  useEffect(() => {
    void refreshDebug();
    // 15 s, not 6 s: the general API limiter is 1000 requests / 15 min per IP
    // and the door's own polling used to ask for ~1350 in that window (measured
    // 90 req/min on an idle debug door) — after ~11 minutes every /api call,
    // including the turn that answers the visitor, came back 429. A door that
    // rate-limits itself is a door that stops hearing.
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshDebug();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refreshDebug]);

  // --- the drawer's own read of the house log -------------------------------
  const refreshLog = useCallback(async () => {
    try {
      const rows = await fetchVoiceEvents(LOG_LIMIT);
      setLog(newestFirst(rows));
      setLogAt(new Date().toISOString());
      setLogError(null);
    } catch (err) {
      setLogError(messageOf(err));
    }
  }, []);

  /**
   * The rail is a DESKTOP-only surface: the stylesheet gives it a column at
   * >=1000px and `display: none` below. Under that breakpoint the debug panels
   * live in the dashed summary card, which is also the tap target that opens the
   * drawer — and on a narrow desktop window that card is squeezed to a sliver
   * (measured 368x29 at 999x700 and 269x10 at 910x512), so a door in that band
   * renders a clean stage with no panels at all. Open the drawer once there: the
   * panes are the whole point of the surface, and the identity pane is first
   * because it is the one the owner reads against `VOICE ID`. The rule is
   * unchanged by the open-by-default order — only its input is: the surfaces are
   * on unless the X was tapped in this session.
   */
  const drawerAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (!debugOn || drawerAutoOpenedRef.current) return;
    drawerAutoOpenedRef.current = true;
    const wide =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 1000px)').matches;
    if (!wide) setDrawer('voice');
  }, [debugOn]);

  useEffect(() => {
    // The rail is always visible on a desktop debug door, so the log polls
    // whenever the debug surface is on — not only when the overlay drawer is open.
    if (drawer === 'closed' && !debugOn) return;
    void refreshLog();
    // 10 s keeps it live while open and keeps the door under the API limiter:
    // the log read is one request, but it shares the 1000/15 min budget with
    // the six debug reads and with the visitor's own turn.
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshLog();
    }, 10000);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer('closed');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [drawer, debugOn, refreshLog]);

  // The transcript reads chronologically, so open it at the newest line.
  useEffect(() => {
    if (drawer !== 'transcript') return;
    const body = drawerBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [drawer, log.length]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRig(stageRef.current?.telemetry() ?? null);
      setTrace(snapshotTrace());
    }, 600);
    return () => window.clearInterval(timer);
  }, []);

  // Mara's real output amplitude, only while she is the one talking. This is
  // the meter the state line shows in SPEAKING — not a CSS animation.
  useEffect(() => {
    if (!speaking) {
      setVoiceLevel(0);
      return;
    }
    const timer = window.setInterval(() => {
      setVoiceLevel(Math.min(1, Math.max(0, agentVoice.getLevel())));
    }, 90);
    return () => window.clearInterval(timer);
  }, [speaking]);

  const showCaption = useCallback((text: string, kind: CaptionKind) => {
    currentTextRef.current = text;
    setCaption(text);
    setCaptionKind(kind);
  }, []);

  const speakStep = useCallback(
    async (
      text: string,
      options: {
        kind: 'filler' | 'answer';
        intent?: ManagerIntent | null;
        turnId?: string;
        tag: CaptionKind;
        /** The spoken language wins over the portal's UI language. */
        language?: PortalLanguage;
      },
    ): Promise<boolean> => {
      showCaption(text, options.tag);
      stageRef.current?.applyCue(text, options.intent ?? undefined);
      // Silent entry: no audio before the visitor's first word.
      if (!audioAllowedRef.current) return true;
      const result = await agentVoice.speak(text, {
        language: options.language ?? language,
        turnId: options.turnId,
        kind: options.kind,
      });
      if (!result.spoken) {
        setError(
          result.reason === 'blocked'
            ? 'sound blocked — tap ENABLE SOUND'
            : `voice ${result.reason ?? 'failed'}`,
        );
        return false;
      }
      return true;
    },
    [language, showCaption],
  );

  /**
   * Greeting: real composed manager text, addressed by the stored claim name.
   *
   * TEXT ONLY — the owner's rule for the door is that entry is SILENT: Mara
   * makes no sound until the visitor has spoken first. So this composes the
   * greeting, paints it on the caption and cues the stage, and never calls the
   * player. (The old version spoke it on mount, which is what greeted a visitor
   * with a voice before they had said a word.)
   */
  const runGreeting = useCallback(async () => {
    const run = (runRef.current += 1);
    setThinking(true);
    setError(null);
    try {
      const result = await fetchManagerTurn({ intent: 'greeting', voiceKey, language });
      if (run !== runRef.current) return;
      showCaption(result.turn.text, 'greeting');
      stageRef.current?.applyCue(result.turn.text, 'greeting', 'greeting');
      await refreshDebug();
    } catch (err) {
      if (run !== runRef.current) return;
      setError(doorErrorCopy(messageOf(err), language));
    } finally {
      if (run === runRef.current) setThinking(false);
    }
  }, [language, refreshDebug, showCaption, voiceKey]);

  /**
   * The shared turn body: transcript -> the existing turn bridge -> streamed
   * answer. Both ears end up here, which is what keeps detection, filler, data
   * answers and the consult queue on exactly one code path.
   *
   * `meta.base` is the LAST VOICED FRAME on this page's clock and every stage
   * below is measured from it (see `doorTimings`). For the streaming ear the
   * base is the provider's own `last_word_end`; for a posted clip it is the VAD's
   * `endAtMs`. Naming the source on the row is what stops a fast streaming
   * number from being read as a batch number.
   */
  const runTurn = useCallback(
    async (
      text: string,
      run: number,
      meta: {
        language: PortalLanguage;
        base: number | null;
        baseSource: TimingBaseSource;
        path: 'stream' | 'batch';
        closedBy?: 'speech_final' | 'utterance_end' | null;
        sttMs: number;
        /** Page clock when the transcript was in hand. */
        sttAt: number;
        blobMs?: number;
        endpointingMs?: number;
      },
    ) => {
      const ledger = new DoorTurnTimings({
        base: meta.base,
        baseSource: meta.baseSource,
        path: meta.path,
        closedBy: meta.closedBy ?? null,
        text,
      });
      ledger.mark('stt', meta.sttAt);

      // Say back what was heard before acting on it: a wrong transcript is
      // visible on the wall, never silently answered.
      showCaption(`“${text}”`, 'status');

      // TALK used to hand the bridge a fixed intent; the words choose one now
      // (unmatched questions stay on the honest consult path).
      const intent = inferVoiceIntent(text);
      const result = await fetchVoiceTurn({
        text,
        voiceKey,
        language: meta.language,
        intent,
      });
      // The Groq turn (data + phrasing) is done: this is the `grogg` stage.
      ledger.mark('grogg', performance.now());
      if (run !== runRef.current) {
        ledger.finish();
        return;
      }
      setTurnTrace({
        turnId: result.turnId,
        kind: result.kind,
        resolvedFrom: result.resolvedFrom,
        needsConsult: result.needsConsult,
        language: meta.language,
        intent: result.intent,
      });
      turnIdRef.current = result.turnId;
      ledger.setTurnId(result.turnId);

      let ttfaMs: number | undefined;
      let answerTtfaMs: number | undefined;
      for (let i = 0; i < result.sequence.length; i += 1) {
        if (run !== runRef.current) break;
        const step = result.sequence[i];
        const stepMark = readVoiceTrace().length;
        const spoke = await speakStep(step.text, {
          kind: step.role,
          intent: result.intent,
          turnId: result.turnId,
          tag: step.role === 'filler' ? 'filler' : 'answer',
          language: meta.language,
        });
        // A barge-in landed while she was talking: this turn is over, and the
        // visitor's words own the floor now.
        if (run !== runRef.current) break;
        if (spoke) {
          // TTFA is audio the visitor actually hears, not the JSON round trip.
          const started = firstAudioAfter(stepMark);
          if (started !== null) {
            // First chunk of THIS turn, whichever step it belongs to.
            if (ttfaMs === undefined) ledger.mark('ttsFirstChunk', started);
            const value = meta.base === null ? undefined : Math.round(started - meta.base);
            if (value !== undefined) {
              if (i === 0) ttfaMs = value;
              if (step.role === 'answer') answerTtfaMs = value;
            }
          }
        }
        if (!spoke) break;
        if (i < result.sequence.length - 1) await agentVoice.whenEnded();
      }

      // One row per turn, printed from the last voiced frame. This is the
      // measurement the streaming ear exists for, so it is never optional.
      ledger.finish();

      setTimings({
        sttMs: meta.sttMs,
        blobMs: meta.blobMs,
        ttfaMs,
        answerTtfaMs,
        turnMs: result.timings.totalMs,
        sttPath: meta.path,
        endpointingMs: meta.endpointingMs,
        closedBy: meta.closedBy ?? undefined,
      });
      await refreshDebug();
    },
    [refreshDebug, showCaption, speakStep, voiceKey, language],
  );

  /**
   * The BATCH ear: one complete clip, posted after the VAD's silence window.
   * Kept as the fallback — a door whose stream socket cannot open must still
   * answer, and this is the path the owner already validated.
   */
  const hearBlob = useCallback(
    async (blob: Blob, endOfSpeechAt: number, blobMs: number) => {
      const run = (runRef.current += 1);
      setThinking(true);
      setError(null);
      setSttError(null);
      setEarBusy('transcribing');
      try {
        const heard = await transcribeUtterance(blob, {
          language: 'auto',
          room: 'coexistir',
          voiceKey,
        });
        if (run !== runRef.current) return;
        setStt(heard);
        sttRef.current = heard.text ?? '';
        // The ear answers with the identity snapshot it held and the clip's
        // measured acoustics; surface both immediately (the 6 s panel poll is
        // the slow path, not the only path).
        if (heard.identity) setDebug((prev) => ({ ...prev, identity: heard.identity ?? prev.identity }));
        if (heard.acoustic) setAcoustic(heard.acoustic);
        setEarBusy('idle');

        if (!heard.ok || !heard.text.trim()) {
          // Silence default: nothing was said, so nothing is demanded. The ear
          // stays open and the door simply keeps waiting — no nag, no prompt,
          // no "tap MIC and try again" (there is no tap to send anymore).
          // The clip is counted, never turned into a turn (review #12).
          setEmptyStt((n) => n + 1);
          setSttError(heard.reason ? `stt ${heard.reason}` : 'no speech');
          logLocal(
            'STT',
            `transcrição falhou · ${heard.reason ?? 'sem texto'}`,
            `${heard.sttMs ?? '—'} ms · ${blobMs} ms de captura`,
          );
          setTimings({ sttMs: heard.sttMs, blobMs, sttPath: 'batch' });
          return;
        }

        // The voice decides the answer language. Only pt/en are speakable; any
        // other detection keeps the door's own language rather than guessing.
        const spokenLanguage: PortalLanguage = heard.language ?? language;
        await runTurn(heard.text, run, {
          language: spokenLanguage,
          base: endOfSpeechAt,
          baseSource: 'vad',
          path: 'batch',
          sttMs: heard.sttMs,
          sttAt: performance.now(),
          blobMs,
        });
      } catch (err) {
        if (run !== runRef.current) return;
        setError(doorErrorCopy(messageOf(err), language));
      } finally {
        if (run === runRef.current) {
          setThinking(false);
          setEarBusy('idle');
        }
      }
    },
    [language, runTurn, logLocal],
  );

  /**
   * The STREAMING ear: the provider already decided the visitor finished, so
   * this is end-of-turn — there is no local silence wait to serve.
   *
   * The one thing that must still work is the continuation merge (review #11),
   * now in its text form: with 500 ms of endpointing a breath mid-sentence is
   * MORE likely to split a turn than it was at 1200 ms, so the merge matters
   * more here, not less. Same window (`CONTINUATION_MS`), same cap
   * (`MAX_MERGES`), same "cancel turn 1" rule — but the two halves are joined as
   * text, because there is no clip to re-send.
   */
  const hearStreamTurn = useCallback(
    async (turn: SttStreamTurnEvent) => {
      if (!listeningRef.current) return;
      audioAllowedRef.current = true;
      lastSpeechAtRef.current = Date.now();
      setVad(vadRef.current?.snapshot() ?? null);
      setStreamState(streamRef.current?.snapshot() ?? null);

      const text = (turn.text ?? '').trim();
      // Silence default (review #12): nothing was said, so nothing is demanded
      // and no clip is invented.
      if (!text) {
        setEmptyStt((n) => n + 1);
        return;
      }

      // The provider's own last voiced frame is the base for every stage; when
      // it is missing (a provider that sent no word timings) fall back to the
      // turn's arrival, marked as an audio-clock estimate rather than a
      // measurement.
      const base = turn.lastWordEndPerf;
      const baseSource: TimingBaseSource = base === null ? 'audio' : 'provider';
      const endpointingMs = streamRef.current?.snapshot().endpointing ?? undefined;

      const previous = lastSendRef.current;
      const onset = turn.speechStartPerf ?? base ?? turn.atPerf;
      const gap = continuationGap(previous ? previous.sentAt : null, onset);
      const canMerge =
        previous !== null &&
        typeof previous.text === 'string' &&
        previous.cutAt === undefined &&
        gap !== null &&
        previous.merges < MAX_MERGES;

      if (previous && canMerge) {
        // Turn 1 was half a sentence: cancel it and answer the joined question.
        runRef.current += 1;
        agentVoice.stop('continuation');
        setThinking(false);
        // It leaves the transcript (with the answer it got), not the log.
        setMergedAway((list) => [
          ...list,
          { turnId: turnIdRef.current ?? undefined, text: sttRef.current.trim() || undefined },
        ]);
        const merged = mergeTranscripts(previous.text ?? '', text);
        lastSendRef.current = {
          sentAt: performance.now(),
          endAtMs: 0,
          sampleRate: 16000,
          merges: previous.merges + 1,
          text: merged,
        };
        setMerges((n) => n + 1);

        // `runRef.current` was already bumped to cancel turn 1; the merged turn
        // inherits that id, so it is the only run allowed to speak.
        const run = runRef.current;
        setThinking(true);
        sttRef.current = merged;
        try {
          await runTurn(merged, run, {
            language: turn.language === 'en' ? 'en' : 'pt',
            base,
            baseSource,
            path: 'stream',
            closedBy: turn.by,
            sttMs: turn.sttMs,
            sttAt: turn.atPerf,
            endpointingMs,
          });
        } catch (err) {
          if (run === runRef.current) setError(doorErrorCopy(messageOf(err), language));
        } finally {
          if (run === runRef.current) setThinking(false);
        }
        setTimingRows(recentDoorTimings());
        return;
      }

      lastSendRef.current = {
        sentAt: performance.now(),
        endAtMs: 0,
        sampleRate: 16000,
        merges: 0,
        text,
      };

      const spokenLanguage: PortalLanguage = turn.language === 'en' ? 'en' : 'pt';
      // What the door heard, in the shape the debug rail and the transcript
      // already read: no invented fields, `sttMs` is the provider's own number.
      sttRef.current = text;
      setStt({
        ok: true,
        provider: 'deepgram',
        model: 'nova-3',
        text,
        language: turn.detectedLanguage === 'en' ? 'en' : turn.language === 'en' ? 'en' : 'pt',
        detectedLanguage: turn.detectedLanguage,
        languageConfidence: null,
        confidence: turn.confidence,
        durationSec: null,
        bytes: 0,
        mimetype: 'audio/pcm;rate=16000',
        sttMs: turn.sttMs,
        providerMs: turn.sttMs,
      });
      setSttError(null);

      const run = (runRef.current += 1);
      setThinking(true);
      setError(null);
      try {
        await runTurn(text, run, {
          language: spokenLanguage,
          base,
          baseSource,
          path: 'stream',
          closedBy: turn.by,
          sttMs: turn.sttMs,
          sttAt: turn.atPerf,
          endpointingMs,
        });
      } catch (err) {
        if (run !== runRef.current) return;
        setError(doorErrorCopy(messageOf(err), language));
      } finally {
        if (run === runRef.current) setThinking(false);
        setTimingRows(recentDoorTimings());
      }
    },
    [runTurn, language],
  );

  // First greeting, once the page is up.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void runGreeting();
  }, [runGreeting]);

  /**
   * Close the current session and open a clean one (review #8/#9). The mic is
   * NOT touched — the lock says it never auto-stops — but everything a public
   * screen could leak is cleared: the rail rows, the transcript, the last thing
   * heard, the timings and the caption. The greeting is composed again as TEXT
   * (entry is silent), so the new visitor is addressed, not the previous one.
   */
  const closeSession = useCallback(
    (reason: string) => {
      sessionStartRef.current = Date.now();
      lastSendRef.current = null;
      lastSpeechAtRef.current = 0;
      setSession((n) => n + 1);
      setSessionBoundary(reason);
      setLog([]);
      setLogAt(null);
      setStt(null);
      setSttError(null);
      setTurnTrace(null);
      setTimings({});
      setMerges(0);
      setMergedAway([]);
      setCaption('');
      setCaptionKind('status');
      void runGreeting();
    },
    [runGreeting],
  );

  /**
   * The idle half of the session boundary: nothing said, nothing in flight, for
   * `SESSION_IDLE_MS`. Checked on a coarse timer because it is a housekeeping
   * rule, not a conversation rule — it must never race the VAD.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!listeningRef.current) return;
      if (agentVoice.snapshot.phase === 'speaking') return;
      if (busyRef.current) return;
      const since = Math.max(lastSpeechAtRef.current, sessionStartRef.current);
      if (Date.now() - since >= sessionIdleMs(window.location.search, debugForced)) closeSession('idle');
    }, 15000);
    return () => window.clearInterval(timer);
  }, [closeSession, debugForced]);

  /**
   * A wall screen's first tap must be audible: unlock audio on the first
   * gesture anywhere. (Browsers refuse to start an AudioContext otherwise,
   * which silently swallows the first reply.)
   */
  useEffect(() => {
    const unlock = () => {
      void agentVoice.unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // --- barge-in + devices ---------------------------------------------------
  const bargeIn = useCallback((reason: string) => {
    runRef.current += 1;
    agentVoice.stop(reason);
    setThinking(false);
    // The interrupting words are NOT thrown away: if they began within the
    // continuation window, the two clips are one sentence she was too quick to
    // answer (a mid-sentence pause), so the clip is kept and stamped rather than
    // dropped. Past the window this is a real interruption and the next clip is
    // simply a new question (gap > CONTINUATION_MS).
    if (lastSendRef.current) lastSendRef.current = { ...lastSendRef.current, cutAt: performance.now() };
    // And her mouth shuts on this frame (ParamA -> 0), not on an eased decay.
    setCutAt((n) => n + 1);
  }, []);

  /**
   * Open the ear — ONCE per mic-ON. The stream, the AudioContext and the VAD
   * live until the visitor taps MIC again; utterances are cut out of that one
   * stream, so there is no reopen, no permission churn, and no auto-stop after
   * a turn. This is the owner's "open ear that never closes by itself".
   */
  const startListening = useCallback(async () => {
    if (vadRef.current) return;
    // A fresh ear after a long silence is a fresh visitor: clear the public rail
    // before anything from this session can land in it.
    if (lastSpeechAtRef.current > 0 && Date.now() - lastSpeechAtRef.current >= sessionIdleMs(window.location.search, debugForced)) {
      closeSession('mic-on');
    }
    // Unlock audio and build the AudioContext inside the tap's user gesture:
    // awaiting first loses the gesture and the meter reads zeros forever.
    void agentVoice.unlock();
    setMicError(null);
    setMicProblem(null);
    setSttError(null);
    listeningRef.current = true;

    /**
     * The streaming ear opens FIRST — before the VAD, so no syllable is missed
     * while the socket handshakes, and so a failed socket leaves the door on the
     * batch path with nothing else to unwind.
     */
    {
      const stream = createPortalSttStream({
        room: 'coexistir',
        language: 'auto',
        onReady: (info) => {
          setSttPath('stream');
          streamGuard.current = streamRef.current;
          setStreamState({
            ready: true,
            endpointing: info.endpointing,
            utteranceEndMs: info.utteranceEndMs,
            audioMs: 0,
            turns: 0,
          });
        },
        onTurn: (turn) => {
          void hearStreamTurn(turn);
        },
        onError: (code, message) => {
          // A stream that cannot open is not an error the visitor sees: the
          // batch ear takes over and the rail says which path answered. But it
          // IS evidence, and the console is not a proof surface — so it lands
          // in the rail's log with the reason.
          console.warn('[portal] stt stream', code, message);
          logLocal('STT', `stream falhou · ${code}`, message);
          if (!streamRef.current?.ready) setSttPath('batch');
        },
        onClose: (reason) => {
          console.warn('[portal] stt stream closed:', reason);
          logLocal('STT', 'stream fechado', reason);
          if (streamRef.current === stream) streamRef.current = null;
          if (streamGuard.current === stream) streamGuard.current = null;
          setSttPath('batch');
          setStreamState(null);
        },
        onWarn: (message) => console.warn('[portal]', message),
      });
      streamRef.current = stream;
      const streaming = await stream.connect();
      if (!streaming) {
        streamRef.current = null;
        streamGuard.current = null;
        setSttPath('batch');
      }
    }

    const handle = createPortalVad({
      isAgentSpeaking: () => agentVoice.snapshot.phase === 'speaking',
      onLevel: (level, info) => {
        setMicLevel(level);
        setMicRms(info.rms);
      },
      /**
       * EVERY block goes to the streaming ear with its AUDIO timestamp. The VAD
       * below still owns level and barge-in detection; the provider owns the
       * turn. Feeding both from the same blocks is what keeps them from ever
       * disagreeing about what the visitor said.
       */
      onFrame: (samples, tMs, rate) => {
        streamRef.current?.send(samples, tMs, rate);
      },
      onSpeechStart: ({ bargeIn: cut, tMs }) => {
        if (!listeningRef.current) return;
        // Remember how many turns the stream had BEFORE this utterance: that is
        // the only baseline the watchdog can trust (see streamTurnsAtSpeechRef).
        streamTurnsAtSpeechRef.current = streamRef.current?.snapshot().turns ?? 0;
        // An onset is an ATTEMPT that succeeded: the log keeps it next to the
        // bar it crossed, so "the VAD never fires" can be told apart from
        // "the VAD fires and the provider answers nothing".
        const snap = vadRef.current?.snapshot();
        if (snap) {
          logLocal(
            'EAR',
            `fala detectada · ${dbfsText(snap.maxRms)}`,
            `bar ${dbfsText(snap.threshold)} · piso ${dbfsText(snap.noiseFloor)} · pré-roll ${VAD_DEFAULTS.preRollMs} ms${cut ? ' · por cima dela' : ''}`,
            `onset ${Math.round(tMs)} ms`,
          );
        }
        // She is audible and the visitor spoke over her: she stops NOW, and
        // the words that cut her are kept as the next question.
        if (cut) bargeIn('vad');
      },
      onUtterance: (blob, info) => {
        if (!listeningRef.current) return;
        // The visitor has spoken: the door may answer with a voice from here.
        audioAllowedRef.current = true;
        lastSpeechAtRef.current = Date.now();
        setVad(vadRef.current?.snapshot() ?? null);

        // --- streaming: the turn is already being answered -------------------
        // The provider's endpointing closed this utterance ~700 ms ago and
        // `hearStreamTurn` dispatched it. This local clip is the SAME speech:
        // posting it would ask the question twice and cost a second Deepgram
        // call. The VAD stays on for level and barge-in only.
        if (streamGuard.current) {
          const stream = streamGuard.current;
          const turnsBefore = streamTurnsAtSpeechRef.current;
          // Watchdog, not a second path: if the provider goes silent on a
          // complete utterance the door would otherwise never answer at all.
          // 1500 ms after the VAD's own end-of-speech (i.e. ~2.7 s after the
          // visitor stopped) is far beyond any turn the stream has ever
          // produced, so this only fires on a broken socket.
          window.setTimeout(() => {
            if (!listeningRef.current) return;
            const live = streamGuard.current;
            if (!live || live !== stream) return;
            if (live.snapshot().turns > turnsBefore) return;
            console.warn('[portal] stream produced no turn for a clipped utterance — posting the clip');
            lastSendRef.current = {
              sentAt: performance.now(),
              endAtMs: info.endAtMs,
              parts: info.parts,
              sampleRate: info.sampleRate,
              merges: 0,
            };
            void hearBlob(blob, info.endAtMs, info.blobMs);
          }, 1500);
          setStreamState(stream.snapshot());
          return;
        }

        // --- continuation merge (review #11) --------------------------------
        // A pause longer than the VAD's silence window already auto-sent clip 1.
        // If speech resumes inside CONTINUATION_MS of that send, the two clips
        // are one sentence: cancel turn 1 and re-send them as ONE question.
        const previous = lastSendRef.current;
        const onset = info.endAtMs - info.speechMs;
        const gap = continuationGap(previous ? previous.sentAt : null, onset);
        const canMerge =
          previous !== null &&
          gap !== null &&
          previous.merges < MAX_MERGES;
        if (previous && canMerge) {
          runRef.current += 1;
          agentVoice.stop('continuation');
          setThinking(false);
          // Turn 1 is cancelled: it leaves the transcript (with the clip it
          // answered), not the log.
          setMergedAway((list) => [
            ...list,
            { turnId: turnIdRef.current ?? undefined, text: sttRef.current.trim() || undefined },
          ]);
          const parts = [...(previous.parts ?? []), ...info.parts];
          const merged = encodeWav(parts, info.sampleRate, VAD_DEFAULTS.outRate);
          lastSendRef.current = {
            sentAt: performance.now(),
            endAtMs: info.endAtMs,
            parts,
            sampleRate: info.sampleRate,
            merges: previous.merges + 1,
          };
          setMerges((n) => n + 1);
          void hearBlob(merged, info.endAtMs, 0);
          return;
        }

        lastSendRef.current = {
          sentAt: performance.now(),
          endAtMs: info.endAtMs,
          parts: info.parts,
          sampleRate: info.sampleRate,
          merges: 0,
        };
        void hearBlob(blob, info.endAtMs, info.blobMs);
      },
      onError: (text, info) => {
        // A permission the browser has already decided for this site is the
        // reason, whatever name the rejection carries: Chromium sometimes
        // reports a blocked device as a TypeError("Not supported").
        const kind: MicErrorKind =
          micPermRef.current === 'denied' ? 'denied' : (info?.kind ?? 'error');
        setMicError(text);
        setMicProblem({ kind, message: text, name: info?.name });
        if (kind === 'denied') setMicPerm('denied');
        logLocal(
          'MIC',
          `getUserMedia falhou · ${kind}${info?.name ? ` (${info.name})` : ''}`,
          text,
        );
      },
      onWarn: (text) => console.warn('[portal]', text),
    });

    vadRef.current = handle;
    window.__portalVad = handle;
    const ok = await handle.start();
    if (!ok) {
      vadRef.current = null;
      window.__portalVad = undefined;
      listeningRef.current = false;
      setMicActive(false);
      setMicRms(null);
      setEarVerdict('idle');
      streamRef.current?.close();
      streamRef.current = null;
      setSttPath('batch');
      return;
    }
    setMicActive(true);
    const opened = handle.snapshot();
    setVad(opened);
    earOpenedAtRef.current = performance.now();
    setEarVerdict('idle');
    // We just captured audio: whatever the permission API guessed, the browser
    // has now proved it — print the real device and the bar it must reach.
    setMicPerm('granted');
    logLocal(
      'MIC',
      `microfone aberto · ${opened.mode} ${opened.sampleRate} Hz`,
      `${opened.deviceLabel || 'dispositivo sem nome'} · bar ${dbfsText(opened.threshold)} · piso ${dbfsText(opened.noiseFloor)}`,
      `permissão granted`,
    );
  }, [bargeIn, closeSession, hearBlob, hearStreamTurn, logLocal]);

  /**
   * Mic OFF is DEAF. The stream closes, so nothing is captured and nothing can
   * be sent; a half-spoken clip dies with the stream instead of being shipped
   * after the visitor asked for silence.
   */
  const stopListening = useCallback(() => {
    listeningRef.current = false;
    const handle = vadRef.current;
    vadRef.current = null;
    window.__portalVad = undefined;
    handle?.stop();
    // The socket dies with the ear: a half-spoken sentence is never shipped
    // after the visitor asked for silence, and the provider is told to drop
    // what it has instead of closing a turn nobody will hear.
    const stream = streamRef.current;
    streamRef.current = null;
    streamGuard.current = null;
    stream?.close();
    setSttPath('batch');
    setStreamState(null);
    setMicActive(false);
    setMicLevel(0);
    setMicRms(null);
    setEarVerdict('idle');
    earOpenedAtRef.current = null;
    setVad(null);
  }, []);

  /**
   * ONE button, ONE meaning: toggle the ear. It never becomes STOP, SEND or
   * INTERRUPT — those are the controls the owner removed. Barge-in needs no
   * button at all: the visitor speaks over her.
   */
  const onMicPress = useCallback(() => {
    if (listeningRef.current) stopListening();
    else void startListening();
  }, [startListening, stopListening]);

  const stopCam = useCallback(() => {
    const stream = camStreamRef.current;
    camStreamRef.current = null;
    stream?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamOn(false);
  }, []);

  const toggleCam = useCallback(async () => {
    if (camStreamRef.current) {
      stopCam();
      return;
    }
    bargeIn('cam');
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 320, facingMode: 'user' },
      });
      camStreamRef.current = stream;
      setCamOn(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => undefined);
      }
    } catch (err) {
      setCamError(messageOf(err));
    }
  }, [bargeIn, stopCam]);

  useEffect(() => {
    if (camOn && videoRef.current && camStreamRef.current) {
      videoRef.current.srcObject = camStreamRef.current;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [camOn]);

  useEffect(
    () => () => {
      stopListening();
      stopCam();
    },
    [stopCam, stopListening],
  );

  // --- derived live values --------------------------------------------------
  const claims = debug.claims;
  /**
   * The identity the panel prints: the live claim read, and for a pinned door
   * that read is about one voiceKey for everybody — so the panel says so
   * (kiosk pin) instead of pretending the name belongs to this visitor.
   */
  const identity = debug.identity ?? null;
  const lastTurnRow = debug.turns[debug.turns.length - 1] ?? null;
  const lastAudio =
    newestFirst(debug.events).find((e): e is VoiceAudioRow => e.event === 'audio') ?? null;
  const lastTurn = debug.turns[debug.turns.length - 1] ?? null;
  const serverFirstChunk = lastAudio?.timings?.firstChunkMs;
  const bridgeOk = debug.health?.ok === true;
  const rigReady = rig?.status === 'ready';
  const phase = blocked ? 'blocked' : doorState;
  const sttMs = timings.sttMs ?? stt?.sttMs;
  const ttfaOk = typeof timings.ttfaMs === 'number' && timings.ttfaMs < 600;
  /**
   * The rail shows the CURRENT session only (review #8): rows older than the
   * session start are the previous visitor's words, and a public screen must not
   * keep them. The server log is untouched — this is a display boundary.
   */
  const sessionLog = log.filter((row) => {
    const at = Date.parse(row.ts);
    return Number.isFinite(at) ? at >= sessionStartRef.current : true;
  });
  /**
   * A merged turn is cancelled: its question and its never-delivered answer do
   * not belong in the transcript (the LOG keeps them — that is what a log is).
   */
  const transcriptLog = sessionLog.filter((row) => {
    if (mergedAway.length === 0) return true;
    const body = row.event === 'turn' ? row.input : row.event === 'stt' ? row.text : '';
    const text = (body ?? '').trim().toLowerCase();
    return !mergedAway.some(
      (gone) =>
        (row.event === 'turn' && gone.turnId && row.turnId === gone.turnId) ||
        (gone.text && text && text === gone.text.trim().toLowerCase()),
    );
  });
  const logRows = [
    ...localLog.filter((row) => {
      const at = Date.parse(row.ts);
      return Number.isFinite(at) ? at >= sessionStartRef.current : true;
    }),
    ...sessionLog.map(describeEvent),
  ].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const transcript = buildTranscript(transcriptLog);

  return (
    <main
      className="portal"
      data-testid="portal-page"
      data-state={doorState}
      data-phase={phase}
      data-mic={micActive ? 'on' : 'off'}
      data-debug={debugOn ? 'on' : 'off'}
      data-rail={debugOn ? 'on' : 'off'}
      data-build={BUILD_ID}
      data-session={session}
      data-merges={merges}
      data-boundary={sessionBoundary || 'none'}
      data-ear={micActive ? earVerdict : 'off'}
      data-ear-problem={micProblem?.kind ?? (earIssue ? earVerdict : 'none')}
      data-mic-perm={micPerm}
      data-mic-dbfs={micDbText}
    >
      {/* The frame is the 9:16 measured box (container-query host). The dock is
          deliberately OUTSIDE it: a fixed child of a `container-type: size`
          element is contained by that element, so a phone with the browser
          toolbar up would keep the dock under the chrome. */}
      <div className="portal__frame">
        <header className="portal__topbar">
        <span>MARA · FRONT DOOR</span>
        {/* Bridge health, NOT presence. "LIVE · ALWAYS ON" next to an IDLE tag
            was the first contradiction in the owner's screenshot: a red pulsing
            LIVE dot has to mean something, and what it means here is that the
            server bridge answers. The door's presence lives in the state line. */}
        <span className={`portal__live ${bridgeOk ? 'is-on' : 'is-down'}`} data-testid="portal-live">
          <i aria-hidden="true" />
          {bridgeOk ? 'BRIDGE OK' : 'BRIDGE DOWN'}
        </span>
      </header>

      <section className="portal__stagewrap">
        <PortalStage
          ref={stageRef}
          speaking={speaking}
          state={doorState}
          stateLabel={copy.label}
          cutAt={cutAt}
        />

        {camOn && (
          <div className="portal__selfview" data-testid="portal-selfview">
            <video ref={videoRef} autoPlay muted playsInline aria-label="Your camera" />
          </div>
        )}

        <div className="portal__who">
          <h1>Mara</h1>
          <p>HOUSE MANAGER · 1:1</p>
          <div className={`portal__eq ${doorState === 'speaking' ? 'is-speaking' : ''}`} aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>

        {blocked && (
          <button
            type="button"
            className="portal__unlock"
            data-testid="portal-enable-sound"
            onClick={() => {
              setError(null);
              // This click IS the gesture: unlock audio before re-speaking.
              void agentVoice.unlock();
              if (currentTextRef.current) {
                void agentVoice.speak(currentTextRef.current, { language, kind: 'answer' });
              }
            }}
          >
            ENABLE SOUND
          </button>
        )}
      </section>

      {/* The portrait summary: every debug row in one dashed box, which is also
          the tap target for the log drawer. It renders on a plain `/portal` like
          the rail, but it is NOT a second rail: below 1000px it is the only
          affordance that opens the drawer, so the rule stays "drawer available,
          auto-opened on VOZ under the breakpoint". */}
      {debugOn && (
      <section
        className="portal__debug"
        data-testid="portal-debug"
        aria-label="Voice identity debug"
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={drawer !== 'closed'}
        onClick={() => setDrawer(drawer === 'closed' ? 'log' : 'closed')}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setDrawer(drawer === 'closed' ? 'log' : 'closed');
          }
        }}
      >
        <header className="portal__debug-head">
          <span>VOICE ID · DEBUG</span>
          <span className={bridgeOk ? 'is-ok' : 'is-warn'}>
            {debug.errors.health ? 'health unavailable' : bridgeOk ? 'bridge ok' : '…'}
          </span>
          <span className="portal__debug-open">
            <DockIcon name="list" />
            LOG
          </span>
        </header>

        {/* VOICE ID — the live identity card. Same component as the desktop rail
            and the drawer's VOZ tab, so portrait can never show a different truth. */}
        <VoiceIdPanel
          identity={identity}
          claims={claims}
          lastTurn={lastTurnRow}
          acoustic={acoustic}
          error={debug.errors.identity ?? debug.errors.claims}
          language={language}
          compact
          testId="portal-voiceid"
        />
        <div className="portal__row">
          <span className="portal__key">voice</span>
          <span className="portal__val" title={debug.profile?.voiceId}>
            {debug.profile ? `${debug.profile.modelId} · ${debug.profile.provider}` : '—'}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">live2d</span>
          <span className="portal__val is-dim" data-testid="portal-voiceid-motion">
            {triggers.length > 0
              ? `${triggers[triggers.length - 1].state} → ${triggers[triggers.length - 1].motionGroup}[${triggers[triggers.length - 1].motionIndex}] · ${triggers[triggers.length - 1].expression}`
              : 'no trigger yet'}
          </span>
        </div>

        {/* --- the input side of the turn: what the ear heard, and what it cost --- */}
        <div className="portal__row">
          <span className="portal__key">heard</span>
          <span
            className={`portal__val ${sttError ? 'is-warn' : stt?.text ? 'is-ok' : 'is-dim'}`}
            data-testid="portal-heard"
            title={stt?.text || sttError || undefined}
          >
            {sttError
              ? sttError
              : stt?.text
                ? `“${stt.text}”${stt.detectedLanguage ? ` · ${stt.detectedLanguage}` : ''}`
                : '—'}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">sttMs</span>
          <span
            className={`portal__val ${
              typeof sttMs === 'number' ? (sttMs < 400 ? 'is-ok' : 'is-warn') : 'is-dim'
            }`}
            data-testid="portal-stt-ms"
            title={stt ? `${stt.provider} ${stt.model} · ${stt.bytes} B ${stt.mimetype}` : undefined}
          >
            {typeof sttMs === 'number' ? `${sttMs} ms` : '—'}
            {typeof stt?.providerMs === 'number' && stt.providerMs > 0
              ? ` · net ${stt.providerMs} ms`
              : ''}
            {typeof stt?.confidence === 'number' ? ` · conf ${stt.confidence.toFixed(2)}` : ''}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">ear</span>
          <span
            className={`portal__val ${sttPath === 'stream' ? 'is-ok' : 'is-warn'}`}
            data-testid="portal-stt-path"
            title={
              sttPath === 'stream'
                ? `provider streaming · endpointing ${streamState?.endpointing ?? '—'} ms · utterance_end ${streamState?.utteranceEndMs ?? '—'} ms · last turn closed by ${timings.closedBy ?? '—'}`
                : 'batch ear (clip posted after the local silence window)'
            }
          >
            {sttPath === 'stream'
              ? `stream · ep ${streamState?.endpointing ?? '—'} ms`
              : 'batch · 1200 ms wait'}
            {timings.closedBy ? ` · ${timings.closedBy}` : ''}
            {/* Audio the ear captured while the relay was away. Without this the
                door prints OUVINDO for a visitor talking into a dead socket. */}
            {streamState?.unsentBlocks
              ? ` · ${streamState.unsentBlocks} ${language === 'pt' ? 'blocos não enviados' : 'blocks unsent'}`
              : ''}
          </span>
        </div>
        {timingRows.length > 0 ? (
          <div className="portal__row">
            <span className="portal__key">waterfall</span>
            <span
              className="portal__val is-dim"
              data-testid="portal-waterfall"
              title="every stage measured from the LAST VOICED FRAME (provider word end when streaming)"
            >
              {(() => {
                const row = timingRows[timingRows.length - 1];
                const ms = (value: number | null) => (value === null ? '—' : `${value}`);
                return `stt ${ms(row.stt)} · grogg ${ms(row.grogg)} · tts ${ms(row.ttsFirstChunk)} · ttfa ${ms(row.ttfa)}`;
              })()}
            </span>
          </div>
        ) : null}
        <div className="portal__row">
          <span className="portal__key">ttfa</span>
          <span
            className={`portal__val ${
              typeof timings.ttfaMs === 'number' ? (ttfaOk ? 'is-ok' : 'is-warn') : 'is-dim'
            }`}
            data-testid="portal-ttfa"
            title={`end of speech → first audio (filler included); answer = first answer audio${
              typeof timings.blobMs === 'number' ? `; capture ${timings.blobMs} ms` : ''
            }`}
          >
            {typeof timings.ttfaMs === 'number' ? `${timings.ttfaMs} ms` : '—'}
            {typeof timings.answerTtfaMs === 'number' ? ` · answer ${timings.answerTtfaMs} ms` : ''}
            {typeof timings.turnMs === 'number' ? ` · turn ${timings.turnMs} ms` : ''}
          </span>
        </div>

        <div className="portal__row">
          <span className="portal__key">first chunk</span>
          <span
            className={`portal__val ${
              typeof serverFirstChunk === 'number'
                ? serverFirstChunk < 600
                  ? 'is-ok'
                  : 'is-warn'
                : 'is-dim'
            }`}
            data-testid="portal-first-chunk"
          >
            {typeof serverFirstChunk === 'number' ? `${serverFirstChunk} ms` : '—'}
            {typeof trace.firstChunkMs === 'number' ? ` · client ${trace.firstChunkMs} ms` : ''}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">last turn</span>
          <span className="portal__val" title={lastTurn?.turnId}>
            {lastTurn
              ? `${lastTurn.kind} · ${lastTurn.turnId} · ${lastTurn.needsConsult ? 'consult' : 'answered'}`
              : '—'}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">mic</span>
          <span
            className={`portal__val ${micError ? 'is-warn' : micActive ? 'is-ok' : 'is-dim'}`}
            data-testid="portal-mic-state"
            title={micProblem?.message}
          >
            {micProblem
              ? `blocked · ${micProblem.kind}${micProblem.name ? ` (${micProblem.name})` : ''}`
              : micActive
                ? `${micDbText} · ${micLevel.toFixed(2)} · ${doorState}`
                : 'off · deaf'}{' '}
            · perm {micPerm}
            {vad?.deviceLabel ? ` · ${vad.deviceLabel}` : ''}
            {' '}· voice {speaking ? 'speaking' : 'idle'}
            {turnTrace ? ` · ${turnTrace.language ?? language} · ${turnTrace.resolvedFrom}` : ''}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">ear</span>
          <span
            className={`portal__val ${earVerdict === 'ok' ? 'is-ok' : earVerdict === 'idle' ? 'is-dim' : 'is-warn'}`}
            data-testid="portal-ear-verdict"
          >
            {micActive ? earVerdict : 'off'}
            {earIssue ? ` · ${earIssue.title}` : ''}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">vad</span>
          <span className="portal__val" data-testid="portal-vad-state">
            {vad
              ? `${vad.onsets} heard · ${vad.barHits} at bar · ${vad.sent} sent · ${Math.round(vad.endSilenceMs)}ms silence · peak ${dbfsText(vad.maxRms)} · floor ${dbfsText(vad.noiseFloor)} / bar ${dbfsText(vad.threshold)}`
              : 'off'}
          </span>
        </div>
        <div className="portal__row">
          <span className="portal__key">rig</span>
          <span className={`portal__val ${rigReady ? 'is-ok' : 'is-warn'}`}>
            {rig ? `${rig.status}${rigReady ? ` · ${rig.frames} frames` : ''}` : 'booting'}
          </span>
        </div>
      </section>
      )}

      {/* THE RAIL (desktop). It renders on a plain `/portal` — no flag needed —
          in the owner's order: VOICE ID → LIVE2D triggers → TRANSCRIPT →
          EVENT LOG. It is a live region, not an overlay, so a 1440p door never
          hides the words behind a scrim; portrait keeps the overlay drawer
          instead (one breakpoint, one behaviour). The X in the head is the
          one-tap dismissal (remembered for the session); `?debug=1` forces the
          rail back on. */}
      {debugOn && (
        <aside className="portal__rail" data-testid="portal-rail" aria-label="Voice identity, transcript and event log">
          <header className="portal__railhead">
            <span className="portal__railtitle">VOICE ID · SESSION {session + 1}</span>
            <span className="portal__railmeta">
              <span className={bridgeOk ? 'is-ok' : 'is-warn'}>
                {debug.errors.health ? 'health unavailable' : bridgeOk ? 'bridge ok' : '…'}
              </span>
              <button
                type="button"
                className="portal__railclose"
                onClick={closeDebugRail}
                aria-label={language === 'pt' ? 'Recolher o painel de depuração' : 'Collapse the debug rail'}
                title={language === 'pt' ? 'Recolher o painel de depuração' : 'Collapse the debug rail'}
                data-testid="portal-rail-close"
              >
                <DockIcon name="close" />
              </button>
            </span>
          </header>

          <div className="portal__rows">
            <VoiceIdPanel
              identity={identity}
              claims={claims}
              lastTurn={lastTurnRow}
              acoustic={acoustic}
              error={debug.errors.identity ?? debug.errors.claims}
              language={language}
              onClaim={claimThisVoice}
              testId="portal-rail-voiceid"
            />
            <div className="portal__row">
              <span className="portal__key">heard</span>
              <span
                className={`portal__val ${sttError ? 'is-warn' : stt?.text ? 'is-ok' : 'is-dim'}`}
                data-testid="portal-rail-heard"
                title={stt?.text || sttError || undefined}
              >
                {sttError ? sttError : stt?.text ? `“${stt.text}”` : '—'}
              </span>
            </div>
            <div className="portal__row">
              <span className="portal__key">stt · ttfa</span>
              <span className="portal__val">
                {typeof sttMs === 'number' ? `${sttMs} ms` : '—'}
                {' · '}
                {typeof timings.ttfaMs === 'number' ? `${timings.ttfaMs} ms` : '—'}
              </span>
            </div>
            <div className="portal__row">
              <span className="portal__key">capture</span>
              <span className="portal__val" data-testid="portal-rail-capture">
                {vad
                  ? `${vad.mode} · ${vad.blocks} blocks · ${vad.gaps} gaps · late ${vad.lateMs} ms${
                      vad.droppedMs > 0 ? ` · DROPPED ${vad.droppedMs} ms` : ''
                    }`
                  : 'off'}
              </span>
            </div>
            <div className="portal__row">
              <span className="portal__key">session</span>
              <span className="portal__val is-dim" data-testid="portal-rail-session" title={`session ${session + 1} · ${merges} merged · ${emptyStt} empty STT · boundary ${sessionBoundary || 'none'}`}>
                #{session + 1} · merges {merges} · empty {emptyStt} · bnd {sessionBoundary || 'none'}
              </span>
            </div>
          </div>

          <section className="portal__railpane" aria-label="Live2D motion triggers">
            <div className="portal__railbody" data-testid="portal-rail-stage">
              <StageTriggerPanel triggers={triggers} language={language} limit={8} />
            </div>
          </section>

          <section className="portal__railpane" aria-label="Session transcript">
            <h2>
              TRANSCRIPT <span>{transcript.length}</span>
            </h2>
            <div className="portal__railbody" data-testid="portal-rail-transcript">
              {transcript.length === 0 ? (
                <p className="portal__drawer-empty">
                  {language === 'pt'
                    ? 'A transcrição começa na primeira pergunta.'
                    : 'The transcript starts at the first question.'}
                </p>
              ) : (
                <ol className="portal__transcript">
                  {transcript.map((line) => (
                    <li key={line.key} className={`portal__line is-${line.role}`} data-language={line.language}>
                      <span className="portal__linewho">{line.who}</span>
                      <span className="portal__linelang">{line.language}</span>
                      <span className="portal__linetime">{clockOf(line.ts)}</span>
                      <p className="portal__linetext">{line.text}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>

          <section className="portal__railpane" aria-label="Event log">
            <h2>
              EVENTOS <span>{logRows.length}</span>
            </h2>
            <div className="portal__railbody" data-testid="portal-rail-log">
              {logRows.length === 0 ? (
                <p className="portal__drawer-empty">
                  {logError
                    ? language === 'pt'
                      ? 'O log não respondeu.'
                      : 'The log did not answer.'
                    : language === 'pt'
                      ? 'Nenhum evento ainda. Fale com a Mara.'
                      : 'No events yet. Speak to Mara.'}
                </p>
              ) : (
                <ol className="portal__log">
                  {logRows.map((row) => (
                    <li key={row.key} className="portal__logrow" data-kind={row.kind}>
                      <span className="portal__logtime">{clockOf(row.ts)}</span>
                      <span className="portal__logkind">{row.kind}</span>
                      <span className="portal__loghead">{row.head}</span>
                      {row.meta ? <span className="portal__logmeta">{row.meta}</span> : null}
                      {row.body ? <span className="portal__logbody">{row.body}</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </aside>
      )}

      <section
        className={`portal__caption is-${captionKind}`}
        data-testid="portal-caption"
        role="status"
        aria-live="polite"
      >
        {caption || (thinking ? 'Mara is reading the house…' : '—')}
      </section>
      </div>

      {/* ONE state line, pinned with the controls it describes. The stage tag
          above prints the same word verbatim, so the door cannot hold two
          opinions. The two buttons below are plain TOGGLES with standard
          glyphs: mic on/off, camera on/off — no text, no send, no stop. */}
      <footer className="portal__dock" aria-label="Front-door controls">
        <div
          className={`portal__state is-${doorState}`}
          data-testid="portal-state"
          data-state={doorState}
          role="status"
          aria-live="polite"
        >
          <span className="portal__state-led" aria-hidden="true" />
          <span className="portal__state-label" data-testid="portal-state-label">
            {copy.label}
          </span>
          <span className="portal__state-hint" data-testid="portal-state-hint">
            {stateHint}
          </span>
          <span
            className="portal__meter"
            data-testid="portal-meter"
            data-level={meterLevel.toFixed(2)}
            aria-hidden="true"
          >
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} className={i < meterLit ? 'is-lit' : ''} />
            ))}
          </span>
          {/* The number beside the bars: the EQ alone cannot tell a quiet mic
              from a dead one, and "0.00" told the visitor nothing at all. */}
          <span className="portal__dbfs" data-testid="portal-dbfs" data-dbfs={micDbText}>
            {micDbText}
          </span>
          <span
            className={`portal__permchip is-${micPerm}`}
            data-testid="portal-mic-perm"
            title={
              language === 'pt'
                ? 'Permissão do microfone neste navegador'
                : 'Microphone permission in this browser'
            }
          >
            mic: {micPerm === 'unknown' ? '—' : micPerm}
          </span>
        </div>

        {/* The plain-language ear problem: blocked, no frames, or a capture
            that opens and delivers no audio. It sits above the dock because a
            visitor cannot act on a tooltip. */}
        {earIssue && (
          <div
            className="portal__earalert"
            data-testid="portal-ear-alert"
            data-kind={micProblem?.kind ?? earVerdict}
            role="alert"
          >
            <span className="portal__earalert-title">{earIssue.title}</span>
            <span className="portal__earalert-how">{earIssue.how}</span>
            <button
              type="button"
              className="portal__earalert-retry"
              data-testid="portal-ear-retry"
              onClick={() => {
                if (micActive) {
                  stopListening();
                  window.setTimeout(() => void startListening(), 60);
                } else {
                  void startListening();
                }
              }}
            >
              {language === 'pt' ? 'Tentar de novo' : 'Try again'}
            </button>
          </div>
        )}

        <div className="portal__dockrow">
          <button
            type="button"
            className={`portal__dockbtn is-mic is-${doorState}${micActive ? ' is-listening' : ''}`}
            onClick={onMicPress}
            aria-pressed={micActive}
            aria-label={
              micActive
                ? language === 'pt'
                  ? 'Desligar o microfone'
                  : 'Turn the microphone off'
                : language === 'pt'
                  ? 'Ligar o microfone'
                  : 'Turn the microphone on'
            }
            data-testid="portal-mic"
            data-state={doorState}
            data-icon={micActive ? 'mic' : 'mic-off'}
            title={micError ?? (micActive ? (language === 'pt' ? 'Microfone ligado' : 'Microphone on') : language === 'pt' ? 'Microfone desligado' : 'Microphone off')}
          >
            <DockIcon name={micActive ? 'mic' : 'mic-off'} />
          </button>
          <button
            type="button"
            className={`portal__dockbtn is-cam ${camOn ? 'is-active' : ''}`}
            onClick={() => void toggleCam()}
            aria-pressed={camOn}
            aria-label={camOn ? 'Fechar a câmera' : 'Abrir a câmera'}
            data-testid="portal-cam"
            data-icon={camOn ? 'camera-off' : 'camera'}
            title={camError ? `Camera: ${camError}` : camOn ? 'Fechar a câmera' : 'Abrir a câmera'}
          >
            <DockIcon name={camOn ? 'camera-off' : 'camera'} />
          </button>
        </div>
      </footer>

      {/* The drawer OVERLAYS the door: portrait stays one page, and nothing
          above it moves. Wide screens dock it to the right instead. It is a
          debug surface, so it follows the same gate as the rail (open by
          default, hidden for the session after the X). */}
      {debugOn && drawer !== 'closed' && (
        <div
          className="portal__drawer"
          role="dialog"
          aria-modal="true"
          aria-label={language === 'pt' ? 'Log da casa' : 'House log'}
          data-testid="portal-drawer"
          data-pane={drawer}
        >
          <header className="portal__drawer-head">
            <div className="portal__drawer-title">
              <b>{language === 'pt' ? 'LOG DA CASA' : 'HOUSE LOG'}</b>
              <small data-testid="portal-drawer-status">
                {logError
                  ? `log indisponível — ${logError}`
                  : `${log.length} ${language === 'pt' ? 'eventos' : 'events'}${
                      logAt ? ` · ${clockOf(logAt)}` : ''
                    }`}
              </small>
            </div>
            <button
              type="button"
              className="portal__drawer-close"
              onClick={() => setDrawer('closed')}
              aria-label={language === 'pt' ? 'Fechar o log' : 'Close the log'}
              data-testid="portal-drawer-close"
            >
              <DockIcon name="close" />
            </button>
          </header>

          <div className="portal__drawer-tabs" role="tablist" aria-label="Log panes">
            <button
              type="button"
              role="tab"
              aria-selected={drawer === 'voice'}
              className={drawer === 'voice' ? 'is-on' : ''}
              onClick={() => setDrawer('voice')}
              data-testid="portal-tab-voice"
            >
              VOZ <span>{triggers.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={drawer === 'log'}
              className={drawer === 'log' ? 'is-on' : ''}
              onClick={() => setDrawer('log')}
              data-testid="portal-tab-log"
            >
              EVENTOS <span>{logRows.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={drawer === 'transcript'}
              className={drawer === 'transcript' ? 'is-on' : ''}
              onClick={() => setDrawer('transcript')}
              data-testid="portal-tab-transcript"
            >
              TRANSCRIÇÃO <span>{transcript.length}</span>
            </button>
          </div>

          <div className="portal__drawer-body" ref={drawerBodyRef} data-testid="portal-drawer-body">
            {drawer === 'voice' ? (
              <div data-testid="portal-drawer-voice">
                <VoiceIdPanel
                  identity={identity}
                  claims={claims}
                  lastTurn={lastTurnRow}
                  acoustic={acoustic}
                  error={debug.errors.identity ?? debug.errors.claims}
                  language={language}
                  onClaim={claimThisVoice}
                  testId="portal-drawer-voiceid"
                />
                <StageTriggerPanel
                  triggers={triggers}
                  language={language}
                  limit={14}
                  testId="portal-drawer-triggers"
                />
                {/* Speak-to-enroll lives on the VOZ tab, under the identity it
                    binds: the name typed above is a claim; the binding below
                    makes it a recognition. Refresh the identity read when a
                    binding lands so the card above shows the person at once. */}
                <VoiceEnrollPanel
                  language={language}
                  debug={debugForced}
                  onBound={() => void refreshDebug()}
                  testId="portal-drawer-enroll"
                />
              </div>
            ) : drawer === 'log' ? (
              logRows.length === 0 ? (
                <p className="portal__drawer-empty">
                  {logError
                    ? language === 'pt'
                      ? 'O log não respondeu.'
                      : 'The log did not answer.'
                    : language === 'pt'
                      ? 'Nenhum evento ainda. Fale com a Mara.'
                      : 'No events yet. Speak to Mara.'}
                </p>
              ) : (
                <ol className="portal__log" data-testid="portal-event-log">
                  {logRows.map((row) => (
                    <li key={row.key} className="portal__logrow" data-kind={row.kind}>
                      <span className="portal__logtime">{clockOf(row.ts)}</span>
                      <span className="portal__logkind">{row.kind}</span>
                      <span className="portal__loghead">{row.head}</span>
                      {row.meta ? <span className="portal__logmeta">{row.meta}</span> : null}
                      {row.body ? <span className="portal__logbody">{row.body}</span> : null}
                    </li>
                  ))}
                </ol>
              )
            ) : transcript.length === 0 ? (
              <p className="portal__drawer-empty">
                {language === 'pt'
                  ? 'A transcrição começa na primeira pergunta.'
                  : 'The transcript starts at the first question.'}
              </p>
            ) : (
              <ol className="portal__transcript" data-testid="portal-transcript">
                {transcript.map((line) => (
                  <li key={line.key} className={`portal__line is-${line.role}`} data-language={line.language}>
                    <span className="portal__linewho">{line.who}</span>
                    <span className="portal__linelang">{line.language}</span>
                    <span className="portal__linetime">{clockOf(line.ts)}</span>
                    <p className="portal__linetext">{line.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="portal__error" role="alert" data-testid="portal-error">
          {error}
        </div>
      )}
    </main>
  );
};

export default PortalPage;
