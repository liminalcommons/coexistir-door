/**
 * doorTimings — one waterfall per spoken turn, measured from the LAST VOICED
 * FRAME.
 *
 * The door's promise is "she answers fast", and the only honest way to keep it
 * is to print the same three numbers every turn, from the same base:
 *
 *   stt              last voiced frame -> transcript in hand
 *   grogg            last voiced frame -> /voice/turn answered (Groq + data)
 *   tts-first-chunk  last voiced frame -> first audio chunk the visitor hears
 *
 * Why the last voiced frame and not "when the recording stopped": the recording
 * stops on a TIMER. On the batch path that timer is 1200 ms of silence, so a
 * waterfall based on the send time would hide the largest cost in the door
 * behind the label "capture". Base everything on the last voiced frame and the
 * silence wait appears exactly where it belongs — inside `stt`.
 *
 * The base has two possible sources and they are NOT the same thing:
 *   - 'provider' (streaming): Deepgram's `last_word_end` mapped onto the page
 *     clock. It is the vendor's own measure of where speech stopped.
 *   - 'vad' (batch): the local VAD's `endAtMs`.
 *   - 'audio' (fallback): audio position inferred from the socket ledger.
 * The source travels with the row, so a fast number is never mistaken for a
 * different kind of fast number.
 */

export type TimingBaseSource = 'provider' | 'vad' | 'audio' | 'none';

export interface DoorTimingRow {
  /** Identifies the turn (empty until /voice/turn answers). */
  turnId: string;
  /** Where the base came from, and what it was worth on the page clock. */
  base: { at: number | null; source: TimingBaseSource };
  /** Stage marks, all deltas from `base.at` (ms, rounded). Null = not reached. */
  stt: number | null;
  grogg: number | null;
  ttsFirstChunk: number | null;
  /** Stage-to-stage deltas, for spotting WHICH stage regressed. */
  deltas: { sttToGrogg: number | null; groggToTts: number | null };
  /** End-to-end: base -> first audio. The number a visitor actually feels. */
  ttfa: number | null;
  /** How the ear was talking to the provider this turn. */
  path: 'stream' | 'batch';
  /** Which provider signal ended the turn (streaming only). */
  closedBy: 'speech_final' | 'utterance_end' | null;
  /** The transcript, for the log line (clipped). */
  text: string;
  at: number;
}

/** Marks that arrive during ONE turn, in the order the door can produce them. */
export type TimingStage = 'stt' | 'grogg' | 'ttsFirstChunk';

const ORDER: TimingStage[] = ['stt', 'grogg', 'ttsFirstChunk'];

export interface DoorTimingOptions {
  /** Where the row goes. Defaults to a `console.info` one-liner. */
  log?: (row: DoorTimingRow, line: string) => void;
  /** Keep a rolling window for the debug rail / harness. Defaults to 20. */
  keep?: number;
  now?: () => number;
}

/**
 * A ledger is created per turn (the page creates one when speech ends) and
 * filled as stages land. It is deliberately not a global: two turns in flight
 * (a barge-in while the answer is still streaming) must not overwrite each
 * other's numbers.
 */
export class DoorTurnTimings {
  private readonly marks = new Map<TimingStage, number>();
  private closed = false;

  constructor(
    private readonly turn: {
      base: number | null;
      baseSource: TimingBaseSource;
      path: 'stream' | 'batch';
      closedBy?: 'speech_final' | 'utterance_end' | null;
      text?: string;
    },
    private readonly options: DoorTimingOptions = {},
  ) {}

  get baseAt(): number | null {
    return this.turn.base;
  }

  /** Record a stage. The FIRST mark wins: a retried stage must not rewrite history. */
  mark(stage: TimingStage, at?: number): void {
    if (this.marks.has(stage)) return;
    const value = at ?? (this.options.now ?? (() => Date.now()))();
    this.marks.set(stage, value);
  }

  /** Attach the turn id once `/voice/turn` has answered. */
  setTurnId(turnId: string, text?: string): void {
    this.turnId = turnId;
    if (text !== undefined) this.turn.text = text;
  }

  private turnId = '';

  /** Round a delta, or null when either end is missing. */
  private delta(from: number | null, to: number | undefined): number | null {
    if (from === null || to === undefined) return null;
    return Math.round(to - from);
  }

  /**
   * Produce the row. Safe to call more than once (the second call is a no-op),
   * because a turn is finished by whichever of "audio ended" / "answer done"
   * happens last.
   */
  finish(): DoorTimingRow {
    const base = this.turn.base;
    const stt = this.marks.get('stt');
    const grogg = this.marks.get('grogg');
    const tts = this.marks.get('ttsFirstChunk');
    const row: DoorTimingRow = {
      turnId: this.turnId,
      base: { at: base, source: this.turn.baseSource },
      stt: this.delta(base, stt),
      grogg: this.delta(base, grogg),
      ttsFirstChunk: this.delta(base, tts),
      deltas: {
        sttToGrogg: stt === undefined ? null : this.delta(stt, grogg),
        groggToTts: grogg === undefined ? null : this.delta(grogg, tts),
      },
      ttfa: this.delta(base, tts),
      path: this.turn.path,
      closedBy: this.turn.closedBy ?? null,
      text: (this.turn.text ?? '').slice(0, 80),
      at: (this.options.now ?? (() => Date.now()))(),
    };
    if (!this.closed) {
      this.closed = true;
      emitDoorTiming(row, this.options);
    }
    return row;
  }

  /** True when every stage has landed. */
  get complete(): boolean {
    return ORDER.every((stage) => this.marks.has(stage));
  }
}

/** The one-line log. Shape is stable: the probes and the harnesses grep it. */
export function formatDoorTiming(row: DoorTimingRow): string {
  const ms = (value: number | null) => (value === null ? '—' : `${value}`);
  return (
    `[door-timing] path=${row.path} base=${row.base.source} ` +
    `stt=${ms(row.stt)} grogg=${ms(row.grogg)} tts-first-chunk=${ms(row.ttsFirstChunk)} ` +
    `ttfa=${ms(row.ttfa)} ` +
    `(stage: +${ms(row.deltas.sttToGrogg)}/+${ms(row.deltas.groggToTts)}) ` +
    `by=${row.closedBy ?? '—'} turn=${row.turnId || '—'} "${row.text}"`
  );
}

const recent: DoorTimingRow[] = [];

/** The last few rows, newest last — what the debug rail and the probes read. */
export function recentDoorTimings(): DoorTimingRow[] {
  return recent.slice();
}

export function clearDoorTimings(): void {
  recent.length = 0;
}

/**
 * Publish one row: the console line (always) plus the rolling window (bounded,
 * so a kiosk left on for a week cannot grow unboundedly).
 */
export function emitDoorTiming(row: DoorTimingRow, options: DoorTimingOptions = {}): void {
  const line = formatDoorTiming(row);
  recent.push(row);
  const keep = options.keep ?? 20;
  while (recent.length > keep) recent.shift();
  if (options.log) {
    options.log(row, line);
    return;
  }
  if (typeof console !== 'undefined') console.info(line);
}
