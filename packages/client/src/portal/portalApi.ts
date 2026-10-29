/**
 * portalApi — the front-door portal's reads and turns.
 *
 * Everything here hits the REAL bridge that slice stream2 built:
 *   GET  /api/coexistir/manager/turn     composed manager text (claim-named)
 *   POST /api/coexistir/voice/turn       ordered speak plan + house log row
 *   GET  /api/coexistir/voice/events       audio rows (first-chunk timings)
 *   GET  /api/coexistir/voice/health     bridge + consult inventory
 *   GET  /api/voice-name-claims          the community claim rows (public read)
 *   GET  /api/tts/config/:agentId        the voice that will actually speak
 *
 * No mock layer: a failure is surfaced to the panel as `unavailable`, never
 * replaced with invented values. The portal must be able to tell the truth
 * about a bridge that is down.
 */

export const PORTAL_AGENT_ID = 'coexistir-manager';

export type PortalLanguage = 'pt' | 'en';

export type ManagerIntent = 'greeting' | 'briefing' | 'todos' | 'reflection';

export interface ManagerTurn {
  managerId: string;
  managerName: string;
  intent: ManagerIntent;
  language: string;
  text: string;
  namedTasks?: string[];
  openCount?: number;
  doneCount?: number;
}

export interface ManagerTurnResult {
  turn: ManagerTurn;
  tasks: Array<{ id: string; title: string; status: 'open' | 'done' }>;
}

export interface VoiceClaim {
  _id?: unknown;
  voiceKey: string;
  claimedName: string;
  normalizedName?: string;
  claimBy: string;
  claimAt?: string;
  status: 'unverified' | 'verified';
}

/**
 * What the bridge knows about WHO is speaking — mirror of the server's
 * `voiceIdentity` record. The important fields are the absent ones:
 *   `biometric` is always false and `confidence` always null, because no
 *   speaker-embedding stage exists in this stack. The panel prints that gap
 *   rather than a made-up percentage.
 */
export interface VoiceIdentity {
  voiceKey: string;
  name: string | null;
  claim: 'none' | 'unverified' | 'verified';
  claims: number;
  verified: number;
  biometric: false;
  confidence: null;
  source: 'voiceKey+name-claims';
  state: 'resolved' | 'pending' | 'error';
  resolvedAt: string | null;
  error?: string;
}

/** Measured clip properties. Labelled as a snapshot, never as a voiceprint. */
export interface AcousticSnapshot {
  durationSec: number;
  rmsDb: number;
  peakDb: number;
  f0Hz: number | null;
  voicing: number;
  centroidHz: number;
  frames: number;
  note: 'acoustic snapshot, not a voiceprint';
}

export interface VoiceTurnStep {
  role: 'filler' | 'answer';
  text: string;
  stream: {
    path: string;
    body: {
      text: string;
      language: string;
      agentId: string;
      turnId: string;
      kind: 'filler' | 'answer';
    };
  };
}

export interface VoiceTurnResult {
  turnId: string;
  kind: 'smalltalk' | 'hard';
  language: string;
  agentId: string;
  /** Who the bridge believed spoke, recorded on the row (claims, not biometrics). */
  identity: VoiceIdentity | null;
  speaker?: string | null;
  classification: { reason: string; flags: string[] };
  sequence: VoiceTurnStep[];
  filler: string | null;
  answer: string;
  needsConsult: boolean;
  consultQueued: boolean;
  resolvedFrom: 'talker' | 'tasks' | 'consult-ack';
  intent: ManagerIntent | null;
  model: string | null;
  fallback: boolean;
  timings: { talkerMs: number; composeMs: number; totalMs: number };
  consult: { pending: number; pendingPath: string; answerPath: string };
}

export interface VoiceAudioRow {
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
  timings: {
    upstreamMs?: number;
    firstChunkMs?: number;
    headersFlushedMs?: number;
    audioTotalMs?: number;
    abortMs?: number;
  };
  ref?: string | null;
}

export interface VoiceTurnRow {
  event: 'turn';
  turnId: string;
  ts: string;
  voiceKey?: string | null;
  speaker?: string | null;
  /** Who the bridge believed spoke on THIS turn, with the claim state + gap. */
  identity?: VoiceIdentity | null;
  language: string;
  input: string;
  kind: 'smalltalk' | 'hard';
  filler?: string | null;
  reply: string;
  needsConsult: boolean;
  model?: string | null;
  resolvedFrom?: string;
  reason?: string | null;
  flags?: string[];
  timings?: { talkerMs?: number; totalMs?: number };
}

export type VoiceEventRow = VoiceAudioRow | VoiceTurnRow | VoiceSttRow | VoiceConsultRow | VoiceAnswerRow;

/**
 * The two rows the house log writes that the door used to ignore: a hard
 * question queued for Hermes, and the answer it wrote back. They are what the
 * EVENT LOG needs to show the full turn life-cycle, and they come from the
 * same `/voice/events` file — no extra endpoint.
 */
export interface VoiceConsultRow {
  event: 'consult';
  turnId: string;
  ts: string;
  room?: string;
  question: string;
  language: string;
  voiceKey?: string | null;
  status: 'pending' | 'answered';
  reason?: string | null;
  flags?: string[];
  immediateReply?: string;
}

export interface VoiceAnswerRow {
  event: 'answer';
  turnId: string;
  ts: string;
  answer: string;
  answeredBy?: string;
  language?: string;
}

export interface VoiceSttRow {
  event: 'stt';
  ts: string;
  room?: string;
  voiceKey?: string | null;
  identity?: VoiceIdentity | null;
  acoustic?: AcousticSnapshot | null;
  language: string;
  detectedLanguage: string | null;
  text: string;
  confidence?: number | null;
  languageConfidence?: number | null;
  durationSec?: number | null;
  bytes?: number;
  mimetype?: string;
  sttMs: number;
  providerMs?: number;
  model?: string;
  ok?: boolean;
  reason?: string | null;
}

/** What the ear returns: the words plus what it cost to get them. */
export interface SttResult {
  ok: boolean;
  provider: string;
  model: string;
  text: string;
  /** Identity snapshot the ear held (claims only; `confidence` is always null). */
  identity?: VoiceIdentity | null;
  /** Measured clip properties (F0/centroid/level) — not a voiceprint. */
  acoustic?: AcousticSnapshot | null;
  voiceKey?: string | null;
  language: 'pt' | 'en' | null;
  detectedLanguage: string | null;
  languageConfidence: number | null;
  confidence: number | null;
  durationSec: number | null;
  bytes: number;
  mimetype: string;
  /** Server-side: request in -> transcript out. */
  sttMs: number;
  /** Just the Deepgram call. */
  providerMs: number;
  requestedLanguage?: string;
  reason?: string;
  detail?: string;
  status?: number;
}

export interface VoiceHealth {
  ok: boolean;
  agentId: string;
  reflexModel: string;
  house: {
    dir?: string;
    turns?: number;
    audio?: number;
    consults?: number;
  };
  pendingConsults: number;
}

export interface TtsProfile {
  enabled: boolean;
  provider: string;
  voiceId: string;
  modelId: string;
  language: string;
  languages: string[];
  voiceName: string | null;
  isPreConfigured?: boolean;
}

const API = '';

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * A stable per-BROWSER label for a name claim, stored in localStorage.
 *
 * It is not an identity: it is the "who filed it" field the claim policy already
 * takes (`claimBy`), and it only has to be distinct so that one device cannot
 * verify its own claim by typing the same name twice. Two visitors on two
 * devices therefore reach quorum honestly, and the same visitor re-claiming the
 * same name does not.
 */
export function resolveClaimantLabel(): string {
  if (typeof window === 'undefined') return 'door';
  try {
    const saved = window.localStorage.getItem('castalia-portal-claimant');
    if (saved && saved.trim()) return saved.trim();
    const id = `door-${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem('castalia-portal-claimant', id);
    return id;
  } catch {
    /* private mode: a fresh label per call still cannot self-verify alone */
    return `door-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function resolveKioskVoiceKey(): string {
  if (typeof window === 'undefined') return 'owl:front-door';
  const fromUrl = new URLSearchParams(window.location.search).get('voiceKey');
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  try {
    const saved = window.localStorage.getItem('castalia-portal-voice-key');
    if (saved && saved.trim()) return saved.trim();
  } catch {
    /* private mode */
  }
  return 'owl:front-door';
}

export function rememberKioskVoiceKey(voiceKey: string): void {
  try {
    window.localStorage.setItem('castalia-portal-voice-key', voiceKey);
  } catch {
    /* private mode: the URL param still works */
  }
}

export async function fetchManagerTurn(args: {
  intent: ManagerIntent;
  voiceKey?: string;
  displayName?: string;
  language?: PortalLanguage;
  seed?: number;
}): Promise<ManagerTurnResult> {
  const query = new URLSearchParams({ intent: args.intent });
  if (args.voiceKey) query.set('voiceKey', args.voiceKey);
  if (args.displayName) query.set('displayName', args.displayName);
  if (args.language) query.set('language', args.language);
  if (args.seed !== undefined) query.set('seed', String(args.seed));
  const res = await fetch(`${API}/api/coexistir/manager/turn?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await readJson<Partial<ManagerTurnResult>>(res);
  if (!body.turn || typeof body.turn.text !== 'string' || !body.turn.text.trim()) {
    throw new Error('manager returned an empty turn');
  }
  return { turn: body.turn, tasks: Array.isArray(body.tasks) ? body.tasks : [] };
}

export async function fetchVoiceTurn(args: {
  text: string;
  voiceKey?: string;
  language?: PortalLanguage;
  intent?: ManagerIntent;
}): Promise<VoiceTurnResult> {
  const res = await fetch(`${API}/api/coexistir/voice/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      text: args.text,
      voiceKey: args.voiceKey,
      language: args.language ?? 'pt',
      intent: args.intent,
      room: 'coexistir',
    }),
  });
  const body = await readJson<VoiceTurnResult>(res);
  if (!Array.isArray(body.sequence) || body.sequence.length === 0) {
    throw new Error('voice bridge returned no speak plan');
  }
  return body;
}

/**
 * Send one recorded utterance to the server's ear.
 *
 * The Blob goes up as the raw body with the recorder's own MIME type
 * (`audio/webm` from Chrome's MediaRecorder), so the server hands Deepgram the
 * exact bytes the browser produced — no re-encoding, no container guesswork.
 * `language: 'auto'` lets the door answer an English visitor in English at a
 * Portuguese kiosk; a portal `?lang=` is a UI hint, not a listening constraint.
 */
export async function transcribeUtterance(
  blob: Blob,
  options: {
    language?: 'auto' | 'pt' | 'en';
    room?: string;
    timeoutMs?: number;
    /** The voice this clip belongs to — recorded with the transcript. */
    voiceKey?: string;
  } = {},
): Promise<SttResult> {
  const query = new URLSearchParams({
    language: options.language ?? 'auto',
    room: options.room ?? 'coexistir',
  });
  if (options.voiceKey) query.set('voiceKey', options.voiceKey);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(`${API}/api/coexistir/voice/stt?${query.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'audio/webm',
        Accept: 'application/json',
      },
      body: blob,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
  // 502/503 still carry the typed reason; surface it instead of a bare status.
  const body = (await res.json().catch(() => null)) as (SttResult & { error?: string }) | null;
  if (!res.ok && (!body || typeof body !== 'object')) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  if (!body) throw new Error('ear returned an empty body');
  return {
    ...body,
    ok: body.ok === true && res.ok,
    sttMs: typeof body.sttMs === 'number' ? body.sttMs : 0,
  };
}

/**
 * Which manager intent a SPOKEN question is asking for, if any.
 *
 * The removed TALK button used to supply this as a constant (`briefing`,
 * `todos`, `reflection`). With speech there is no button to carry it, so the
 * words pick the same four intents — narrowly, and only on clear phrasing.
 * Anything unmatched returns `undefined`, which leaves the bridge on its own
 * classification (honest filler + consult queue) instead of guessing a data
 * answer the visitor never asked for.
 */
export function inferVoiceIntent(text: string): ManagerIntent | undefined {
  const value = (text || '').toLowerCase();
  if (!value.trim()) return undefined;
  // Reflection first: "o que eu deveria pensar hoje?" also says "hoje".
  if (/\b(pensar|reflex[ãa]o|reflection|conselho|advice)\b/.test(value)) return 'reflection';
  if (/\b(briefing|resumo|summary|como (est[áa]|vai) a casa|status da casa)\b/.test(value)) {
    return 'briefing';
  }
  if (
    /\b(lista|tarefas?|afazeres|pend[êe]ncias|to-?dos?)\b/.test(value) ||
    /\b(what|o que) (is|tem|h[áa])\b.*\b(list|lista|hoje|today)\b/.test(value)
  ) {
    return 'todos';
  }
  return undefined;
}

export async function listVoiceClaims(voiceKey: string): Promise<VoiceClaim[]> {
  const res = await fetch(
    `${API}/api/voice-name-claims?voiceKey=${encodeURIComponent(voiceKey)}`,
    { headers: { Accept: 'application/json' } },
  );
  const body = await readJson<{ claims?: VoiceClaim[] }>(res);
  return Array.isArray(body.claims) ? body.claims : [];
}

/** What the claim endpoint answers: the row it filed, and whether it verified. */
export interface ClaimFiling {
  claim: VoiceClaim;
  /** `verified` when quorum (or a steward) already covers this name. */
  verified: boolean;
  /** The row's state after the write — the honest answer for the panel. */
  status: 'unverified' | 'verified';
}

/**
 * File a name claim for this voice — the SAME `voice_name_claims` collection the
 * meeting tiles use, with the same Bridge-lite rule: one visitor naming a voice
 * is an UNVERIFIED claim, and only a second distinct claimant (or a steward)
 * makes it verified. Nothing here renames a participant or writes an identity.
 *
 * The door is public, so `claimBy` is a per-browser label rather than a login:
 * that is what keeps the quorum meaningful (one device cannot verify itself by
 * typing twice).
 */
export async function claimVoiceName(input: {
  voiceKey: string;
  claimedName: string;
  claimBy: string;
}): Promise<ClaimFiling> {
  const res = await fetch(`${API}/api/voice-name-claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      voiceKey: input.voiceKey,
      claimedName: input.claimedName,
      claimBy: input.claimBy,
    }),
  });
  const body = await readJson<{ claim?: VoiceClaim; error?: string }>(res);
  if (!res.ok || !body.claim) {
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  const status = body.claim.status === 'verified' ? 'verified' : 'unverified';
  return { claim: body.claim, verified: status === 'verified', status };
}

export async function fetchVoiceIdentity(voiceKey: string): Promise<VoiceIdentity | null> {
  const res = await fetch(
    `${API}/api/coexistir/voice/identity?voiceKey=${encodeURIComponent(voiceKey)}`,
    { headers: { Accept: 'application/json' } },
  );
  const body = await readJson<{ identity?: VoiceIdentity | null }>(res);
  return body.identity ?? null;
}

// --- speak-to-enroll --------------------------------------------------------
// Supervised voice binding: the owner speaks a prompted phrase 2–3 times and
// the server binds the averaged print to the typed name under
// `person:<name>`. The name becomes a label on a voice match, never a free
// claim — an unenrolled voice still resolves no name.

export interface EnrollPrompt {
  text: string;
  lang: 'pt' | 'en';
}

export interface EnrollClipInfo {
  take: number;
  dims: number;
  durationSec: number;
  voicedSec: number;
  f0Hz: number;
  at: string;
}

export interface EnrollSession {
  enrollmentId: string;
  voiceKey: string;
  name: string;
  supervisedBy: string;
  prompt: EnrollPrompt;
  needClips: number;
  clips: EnrollClipInfo[];
  /** Min pairwise cosine once ≥2 clips exist, else null. */
  consistency: number | null;
}

export interface EnrollBinding {
  printId: string;
  voiceKey: string;
  name: string;
  status: 'verified';
  verifyReason: 'enrollment';
  verifiedBy: string;
  clips: number;
  consistency: number;
  threshold: number;
  enrolledAt: string;
}

export interface EnrollVerification {
  match: boolean;
  similarity: number | null;
  threshold: number;
  voiceKey: string;
  printId: string | null;
  voicedSec: number;
}

async function readEnrollError(res: Response): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    detail = body.detail ? `${body.error ?? 'enroll failed'} — ${body.detail}` : (body.error ?? detail);
  } catch {
    /* status text stands */
  }
  return new Error(detail);
}

export async function startEnrollment(input: {
  name: string;
  supervisedBy: string;
  promptIndex?: number;
}): Promise<EnrollSession> {
  const res = await fetch(`${API}/api/coexistir/voice/id/enroll/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readEnrollError(res);
  return (await res.json()) as EnrollSession;
}

export async function fetchEnrollStatus(enrollmentId: string): Promise<EnrollSession> {
  const res = await fetch(
    `${API}/api/coexistir/voice/id/enroll/status?enrollmentId=${encodeURIComponent(enrollmentId)}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw await readEnrollError(res);
  return (await res.json()) as EnrollSession;
}

export async function postEnrollClip(
  enrollmentId: string,
  blob: Blob,
): Promise<EnrollSession & { take: number; voicedSec: number; durationSec: number; f0Hz: number }> {
  const res = await fetch(
    `${API}/api/coexistir/voice/id/enroll/clip?enrollmentId=${encodeURIComponent(enrollmentId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/wav', Accept: 'application/json' },
      body: blob,
    },
  );
  if (!res.ok) throw await readEnrollError(res);
  return (await res.json()) as EnrollSession & {
    take: number;
    voicedSec: number;
    durationSec: number;
    f0Hz: number;
  };
}

export async function finishEnrollment(enrollmentId: string): Promise<EnrollBinding> {
  const res = await fetch(`${API}/api/coexistir/voice/id/enroll/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ enrollmentId }),
  });
  if (!res.ok) throw await readEnrollError(res);
  return (await res.json()) as EnrollBinding;
}

export async function verifyEnrollment(voiceKey: string, blob: Blob): Promise<EnrollVerification> {
  const res = await fetch(
    `${API}/api/coexistir/voice/id/enroll/verify?voiceKey=${encodeURIComponent(voiceKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/wav', Accept: 'application/json' },
      body: blob,
    },
  );
  if (!res.ok) throw await readEnrollError(res);
  return (await res.json()) as EnrollVerification;
}

export async function fetchVoiceHealth(): Promise<VoiceHealth> {
  const res = await fetch(`${API}/api/coexistir/voice/health`, {
    headers: { Accept: 'application/json' },
  });
  return readJson<VoiceHealth>(res);
}

export async function fetchVoiceEvents(limit = 40): Promise<VoiceEventRow[]> {
  const res = await fetch(`${API}/api/coexistir/voice/events?limit=${limit}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await readJson<{ events?: VoiceEventRow[] }>(res);
  return Array.isArray(body.events) ? body.events : [];
}

export async function fetchVoiceTurns(limit = 5): Promise<VoiceTurnRow[]> {
  const res = await fetch(`${API}/api/coexistir/voice/turns?limit=${limit}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await readJson<{ turns?: VoiceTurnRow[] }>(res);
  return Array.isArray(body.turns) ? body.turns : [];
}

export async function fetchTtsProfile(agentId = PORTAL_AGENT_ID): Promise<TtsProfile> {
  const res = await fetch(`${API}/api/tts/config/${encodeURIComponent(agentId)}`, {
    headers: { Accept: 'application/json' },
  });
  return readJson<TtsProfile>(res);
}

/** Newest row first (the API returns the tail in chronological order). */
export function newestFirst<T>(rows: T[]): T[] {
  return [...rows].reverse();
}
