/**
 * houseTranscript — the append-only house log the Hermes profile reads.
 *
 * The two-loop design has a hard seam: the room answers instantly, but the
 * household brain (Hermes) is not in the audio path. Every turn therefore lands
 * in a plain JSONL file under the Hermes home, and hard questions are appended
 * to a consult queue that a Hermes profile (cron job or a file-reading agent)
 * can drain asynchronously:
 *
 *   ~/.hermes/house/coexistir/turns.jsonl           every turn + audio timing
 *   ~/.hermes/house/coexistir/consult-queue.jsonl   hard questions, status=pending
 *   ~/.hermes/house/coexistir/consult-answers.jsonl Hermes replies (written back)
 *   ~/.hermes/house/coexistir/audio/<turnId>.mp3    the audio that was played
 *
 * Why files and not a DB: the reader is a Hermes profile ("read this file and
 * answer what is pending"), which needs no credentials, no schema and no running
 * service — and the log survives a server restart. Override the root with
 * `COEXISTIR_HOUSE_DIR` (tests and alternative profiles use it).
 *
 * Rows are append-only; nothing is rewritten, so a crashed turn leaves a
 * readable prefix and never a corrupt file.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type HouseEvent = 'turn' | 'audio' | 'consult' | 'answer' | 'barge-in' | 'stt' | 'voice';

/**
 * What the door decided about WHO spoke, attached to a turn.
 * `status` is the honest verdict: `identified` only when an enrolled voiceprint
 * matched AND a claim resolved to a name; `unenrolled` means "a voice, not a
 * name"; `no_audio` means the turn had no clip behind it (typed or greeting).
 */
export interface TurnVoice {
  status: 'identified' | 'unenrolled' | 'no_audio' | 'empty' | 'disabled' | 'error';
  printId: string | null;
  voiceKey: string | null;
  matched: boolean;
  similarity: number | null;
  dims: number | null;
  /** Fingerprint wall time — overlapped with STT, never added to the turn. */
  ms: number | null;
  /** Actual CPU consumed by the fingerprint (ms); coarse on Windows. */
  cpuMs: number | null;
  traceId: string | null;
  /** How old the ear observation was when this turn attached it. */
  ageMs: number | null;
  claimStatus: 'none' | 'pending' | 'resolved';
  threshold: number | null;
  source: 'wav-embedding';
}

/** A community name claim standing behind the speaker name (slice-2 rule). */
export interface TurnClaim {
  name: string;
  status: 'verified' | 'unverified';
  voiceKey: string;
  source: 'voice_name_claims';
}

import type { VoiceIdentity } from '../naming/voiceIdentity';
import type { AcousticSnapshot } from './acousticSnapshot';

export interface TurnTimings {
  /** Reflex talker round trip (Groq) — 0 when the reply was a filler. */
  talkerMs?: number;
  /** Handler entry to JSON response. */
  totalMs?: number;
  /** Provider headers to the stream route. */
  upstreamMs?: number;
  /** Handler entry to the first audio chunk written to the client. */
  firstChunkMs?: number;
  /** Handler entry to headers flushed (client TTFB). */
  headersFlushedMs?: number;
  /** Handler entry to the last chunk. */
  audioTotalMs?: number;
  /** Client-observed abort latency (client reports this back, optional). */
  abortMs?: number;
}

export interface HouseTurnRow {
  event: 'turn';
  turnId: string;
  ts: string;
  room: string;
  voiceKey?: string | null;
  speaker?: string | null;
  /**
   * Who the bridge believed was speaking, and what backs that belief.
   * `speaker` is the claim name when one exists (it used to be null on every
   * door turn because the client never sent a displayName); `identity` carries
   * the claim state, the quorum counts and the explicit "no voiceprint" facts.
   */
  identity?: VoiceIdentity | null;
  language: string;
  input: string;
  kind: 'smalltalk' | 'hard';
  /** Text spoken before the real answer (null when the answer came first). */
  filler?: string | null;
  reply: string;
  needsConsult: boolean;
  model?: string | null;
  fallback?: boolean;
  timings?: TurnTimings;
  audio?: { ref?: string | null; mime?: string; bytes?: number; modelId?: string | null };
  /** Human-readable reason the turn was classified hard. */
  reason?: string | null;
  flags?: string[];
  /** Who the ear heard, when a clip preceded this turn. */
  voice?: TurnVoice | null;
  /** The community claim that supplied `speaker`, when one did. */
  claim?: TurnClaim | null;
  /** Where `speaker` came from — a claim, the caller, or nothing. */
  speakerSource?: 'claim' | 'client' | null;
}

export interface HouseAudioRow {
  event: 'audio';
  turnId: string;
  ts: string;
  kind: 'filler' | 'answer';
  language: string;
  modelId: string;
  voiceId: string;
  bytes: number;
  chunks: number;
  aborted: boolean;
  timings: TurnTimings;
  ref?: string | null;
}

export interface HouseSttRow {
  event: 'stt';
  ts: string;
  room: string;
  /** The voice the clip was captured for (the kiosk pins one key at the door). */
  voiceKey?: string | null;
  /** The identity snapshot held when the clip landed (claims, never biometrics). */
  identity?: VoiceIdentity | null;
  /** Measured clip properties (F0/centroid/level); NOT a voiceprint. */
  acoustic?: AcousticSnapshot | null;
  /** What the client asked for: `auto` or a BCP-47 tag. */
  language: string;
  /** What the provider heard, e.g. `pt` / `en`. */
  detectedLanguage: string | null;
  text: string;
  confidence: number | null;
  languageConfidence: number | null;
  durationSec: number | null;
  bytes: number;
  mimetype: string;
  /** Server-side handler entry -> transcript (the portal's TTFA pays this). */
  sttMs: number;
  providerMs: number;
  model: string;
  ok: boolean;
  reason?: string | null;
  /**
   * The door's own answer language for this clip (`pt` unless the words
   * backed an English turn), plus the provider verdict it may have overruled.
   * Written on every row so a disagreement can be audited after the fact.
   */
  doorLanguage?: 'pt' | 'en' | null;
  detectedTurnLanguage?: 'pt' | 'en' | null;
  languageReason?: string | null;
  /**
   * The fingerprint computed from this same clip, side by side with the words.
   * `status`/`printId`/`similarity` are the ear's verdict; `claimStatus`
   * separates "no claim yet" from "no claim exists". The fingerprint runs
   * during the provider wait, so `ms` is overlap, not added latency.
   */
  voice?: {
    status: string;
    printId: string | null;
    voiceKey: string | null;
    matched: boolean;
    similarity: number | null;
    dims: number | null;
    durationSec: number;
    voicedSec: number;
    threshold: number;
    ms: number;
    cpuMs: number;
    claim: TurnClaim | null;
    claimStatus: 'none' | 'pending' | 'resolved';
    traceId: string;
    /** True when the fingerprint was already done before the transcript was. */
    readyBeforeStt: boolean;
  } | null;
}

/**
 * One row per ear observation: the fingerprint timeline, on its own file so a
 * debug panel can read voice identity without parsing turn rows.
 * Nothing here is a name unless a claim resolved.
 */
export interface HouseVoiceRow {
  event: 'voice';
  ts: string;
  room: string;
  traceId: string;
  status: string;
  printId: string | null;
  voiceKey: string | null;
  matched: boolean;
  similarity: number | null;
  dims: number | null;
  durationSec: number;
  voicedSec: number;
  ms: number;
  cpuMs: number;
  threshold: number;
  newCluster: boolean;
  claim: TurnClaim | null;
  claimStatus: 'none' | 'pending' | 'resolved';
  /** `observed` when the ear wrote it; `attached` when a turn consumed it. */
  phase?: 'observed' | 'attached';
  /** Set on the `attached` row: the turn that consumed this observation. */
  turnId?: string | null;
}

export interface ConsultRow {
  event: 'consult';
  turnId: string;
  ts: string;
  room: string;
  question: string;
  language: string;
  voiceKey?: string | null;
  status: 'pending' | 'answered';
  reason?: string | null;
  flags?: string[];
  /** The instant answer already given, so Hermes knows what was promised. */
  immediateReply?: string;
}

export interface ConsultAnswerRow {
  event: 'answer';
  turnId: string;
  ts: string;
  answer: string;
  answeredBy?: string;
  language?: string;
}

export interface HouseStore {
  dir: string;
  turnsFile: string;
  consultFile: string;
  answersFile: string;
  audioDir: string;
  /** Voice-identity observations (fingerprints, never stranger audio). */
  voiceIdFile: string;
}

export function resolveHouseDir(dir?: string): HouseStore {
  const root =
    dir ||
    process.env.COEXISTIR_HOUSE_DIR ||
    join(homedir(), '.hermes', 'house', 'coexistir');
  return {
    dir: root,
    turnsFile: join(root, 'turns.jsonl'),
    consultFile: join(root, 'consult-queue.jsonl'),
    answersFile: join(root, 'consult-answers.jsonl'),
    audioDir: join(root, 'audio'),
    voiceIdFile: join(root, 'voice-id.jsonl'),
  };
}

function ensure(store: HouseStore): void {
  mkdirSync(store.dir, { recursive: true });
  mkdirSync(store.audioDir, { recursive: true });
}

function appendJsonl(file: string, row: unknown): void {
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * Parse a JSONL file, skipping a torn last line instead of throwing: a server
 * killed mid-write must not make the whole history unreadable.
 */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  const rows: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      /* partial line from a crashed writer */
    }
  }
  return rows;
}

/** `t_<base36 time>_<rand>` — sortable-ish and unique per process. */
export function newTurnId(now: number = Date.now()): string {
  return `t_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function audioRefFor(turnId: string, kind: 'filler' | 'answer' = 'answer'): string {
  return `audio/${turnId}.${kind}.mp3`;
}

export interface TurnLogInput
  extends Omit<HouseTurnRow, 'event' | 'turnId' | 'ts' | 'room' | 'audio'> {
  turnId: string;
  ts?: string;
  room?: string;
  audioRef?: string | null;
}

export function recordTurn(input: TurnLogInput, store: HouseStore = resolveHouseDir()): HouseTurnRow {
  ensure(store);
  const row: HouseTurnRow = {
    event: 'turn',
    turnId: input.turnId,
    ts: input.ts ?? new Date().toISOString(),
    room: input.room ?? 'coexistir',
    voiceKey: input.voiceKey ?? null,
    speaker: input.speaker ?? null,
    identity: input.identity ?? null,
    language: input.language,
    input: input.input,
    kind: input.kind,
    filler: input.filler ?? null,
    reply: input.reply,
    needsConsult: input.needsConsult,
    model: input.model ?? null,
    fallback: input.fallback ?? false,
    timings: input.timings ?? {},
    audio: { ref: input.audioRef ?? null, mime: 'audio/mpeg' },
    reason: input.reason ?? null,
    flags: input.flags ?? [],
    voice: input.voice ?? null,
    claim: input.claim ?? null,
    speakerSource: input.speakerSource ?? null,
  };
  appendJsonl(store.turnsFile, row);
  return row;
}

/**
 * One voice-identity observation. Its own append-only file: the panel reads it
 * whole (no filtering by event), and a stranger's fingerprint is only ever a
 * printId — there is no name to leak.
 */
export function recordVoice(
  row: Omit<HouseVoiceRow, 'event' | 'ts'> & { ts?: string },
  store: HouseStore = resolveHouseDir(),
): HouseVoiceRow {
  ensure(store);
  const full: HouseVoiceRow = { event: 'voice', ts: row.ts ?? new Date().toISOString(), ...row };
  appendJsonl(store.voiceIdFile, full);
  return full;
}

export function readVoiceIdRows(
  store: HouseStore = resolveHouseDir(),
  limit = 50,
): HouseVoiceRow[] {
  const rows = readJsonl<HouseVoiceRow>(store.voiceIdFile).filter((r) => r.event === 'voice');
  return rows.slice(Math.max(0, rows.length - limit));
}

export function recordAudio(
  row: Omit<HouseAudioRow, 'event' | 'ts'>,
  store: HouseStore = resolveHouseDir(),
): HouseAudioRow {
  ensure(store);
  const full: HouseAudioRow = { event: 'audio', ts: new Date().toISOString(), ...row };
  appendJsonl(store.turnsFile, full);
  return full;
}

/**
 * One transcription row. Written to the same append-only file as turns and
 * audio so the portal's debug panel, the harness and a Hermes profile all read
 * a single timeline: what was heard, how fast, then what was answered.
 */
export function recordStt(
  row: Omit<HouseSttRow, 'event' | 'ts'> & { ts?: string },
  store: HouseStore = resolveHouseDir(),
): HouseSttRow {
  ensure(store);
  const full: HouseSttRow = { event: 'stt', ts: row.ts ?? new Date().toISOString(), ...row };
  appendJsonl(store.turnsFile, full);
  return full;
}

export function queueConsult(
  row: Omit<ConsultRow, 'event' | 'ts' | 'status'> & { ts?: string; status?: 'pending' | 'answered' },
  store: HouseStore = resolveHouseDir(),
): ConsultRow {
  ensure(store);
  const full: ConsultRow = {
    event: 'consult',
    ts: row.ts ?? new Date().toISOString(),
    status: row.status ?? 'pending',
    ...row,
  } as ConsultRow;
  appendJsonl(store.consultFile, full);
  return full;
}

export function answerConsult(
  row: Omit<ConsultAnswerRow, 'event' | 'ts'> & { ts?: string },
  store: HouseStore = resolveHouseDir(),
): ConsultAnswerRow {
  ensure(store);
  const full: ConsultAnswerRow = {
    event: 'answer',
    ts: row.ts ?? new Date().toISOString(),
    ...row,
  };
  appendJsonl(store.answersFile, full);
  return full;
}

export function readTurns(store: HouseStore = resolveHouseDir(), limit = 50): HouseTurnRow[] {
  const rows = readJsonl<HouseTurnRow>(store.turnsFile).filter((r) => r.event === 'turn');
  return rows.slice(Math.max(0, rows.length - limit));
}

export function readAllEvents(
  store: HouseStore = resolveHouseDir(),
  limit = 200,
): Array<HouseTurnRow | HouseAudioRow | HouseSttRow> {
  const rows = readJsonl<HouseTurnRow | HouseAudioRow | HouseSttRow>(store.turnsFile);
  return rows.slice(Math.max(0, rows.length - limit));
}

export interface PendingConsult extends ConsultRow {
  askedAt: string;
  answered: boolean;
  answer?: string;
}

/**
 * Pending consults = queued questions with no matching answer row yet.
 * This is the exact list a Hermes cron/profile is expected to read.
 */
export function pendingConsults(store: HouseStore = resolveHouseDir()): PendingConsult[] {
  const queue = readJsonl<ConsultRow>(store.consultFile);
  const answers = readJsonl<ConsultAnswerRow>(store.answersFile);
  const byTurn = new Map<string, ConsultAnswerRow>();
  for (const a of answers) byTurn.set(a.turnId, a);
  return queue
    .filter((row) => row.event === 'consult')
    .map((row) => {
      const answer = byTurn.get(row.turnId);
      return {
        ...row,
        askedAt: row.ts,
        answered: Boolean(answer),
        answer: answer?.answer,
      };
    })
    .filter((row) => !row.answered);
}

/** Every consult row joined with its answer (for the tile / review UI). */
export function consultHistory(store: HouseStore = resolveHouseDir(), limit = 50): PendingConsult[] {
  const queue = readJsonl<ConsultRow>(store.consultFile);
  const answers = readJsonl<ConsultAnswerRow>(store.answersFile);
  const byTurn = new Map<string, ConsultAnswerRow>();
  for (const a of answers) byTurn.set(a.turnId, a);
  return queue
    .filter((row) => row.event === 'consult')
    .map((row) => {
      const answer = byTurn.get(row.turnId);
      return { ...row, askedAt: row.ts, answered: Boolean(answer), answer: answer?.answer };
    })
    .slice(-limit);
}

/** Files currently under the house dir — used by the health/consult API. */
export function houseInventory(store: HouseStore = resolveHouseDir()): {
  dir: string;
  files: Array<{ name: string; bytes: number }>;
  audioFiles: number;
} {
  if (!existsSync(store.dir)) return { dir: store.dir, files: [], audioFiles: 0 };
  const files = [store.turnsFile, store.consultFile, store.answersFile]
    .filter((f) => existsSync(f))
    .map((f) => ({ name: f.slice(store.dir.length + 1), bytes: statSync(f).size }));
  const audioFiles = existsSync(store.audioDir)
    ? readdirSync(store.audioDir).filter((f) => f.endsWith('.mp3')).length
    : 0;
  return { dir: store.dir, files, audioFiles };
}
