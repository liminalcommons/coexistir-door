/**
 * stageTriggers — the proof surface for the Live2D state map.
 *
 * Every time the door tells the rig to change state it records ONE line here and
 * prints it to the console with a stable prefix:
 *
 *   [live2d:trigger] state=excited · once · motion TapBody[4] special_02.motion3.json (rainbow spark burst) · expression exp_04 (sparkle eyes) · applied=true · why=turn-text
 *
 * Why a module and not a bare console.log: the trigger has to be checkable in
 * three places at once — the browser console (raw), the debug rail (the owner
 * reads it), and `window.__portalStage.triggers()` (the probe asserts every map
 * entry fired). One ring buffer feeds all three, so they cannot disagree, and the
 * `applied` flag is whatever the rig actually returned (`playMotion` /
 * `setExpression` booleans) — never an assumption.
 */
import { describeInstruction, type AgentState, type StageInstruction } from './motionMap';

export type TriggerReason = 'boot' | 'door-state' | 'turn-text' | 'barge-in' | 'debug';

export interface TriggerRecord {
  /** Monotonic per page load. */
  seq: number;
  /** `performance.now()` at the moment the rig was told. */
  at: number;
  /** Wall clock, so the rail can print a time next to the log's own times. */
  ts: string;
  state: AgentState;
  beat: 'once' | 'loop';
  motionGroup: string;
  motionIndex: number;
  motionFile: string;
  motionLabel: string;
  expression: string;
  expressionLabel: string;
  /** Did the rig accept BOTH commands (motion + expression)? */
  applied: boolean;
  /** What asked for the change. */
  why: TriggerReason;
  /** The instruction line, verbatim (the console prints the same string). */
  line: string;
}

const MAX = 60;

/**
 * The door only prints trigger lines when it was opened with `?debug=1`, and it
 * reaches the console through `window.console` on purpose: the production Vite
 * config drops bare `console.*` calls (`esbuild.drop: ['console','debugger']`),
 * which used to make these proof lines vanish from the built door. A public door
 * stays silent; a debug door prints one line per state change.
 */
const DEBUG_ON = (() => {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.location !== 'undefined' &&
      new URLSearchParams(window.location.search).get('debug') === '1'
    );
  } catch {
    return false;
  }
})();

let seq = 0;
let records: TriggerRecord[] = [];
const listeners = new Set<(rows: TriggerRecord[]) => void>();

export function recordTrigger(args: {
  instruction: StageInstruction;
  applied: boolean;
  why: TriggerReason;
  note?: string;
}): TriggerRecord {
  const { instruction, applied, why } = args;
  seq += 1;
  const record: TriggerRecord = {
    seq,
    at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    ts: new Date().toISOString(),
    state: instruction.state,
    beat: instruction.beat,
    motionGroup: instruction.motion.group,
    motionIndex: instruction.motion.index,
    motionFile: instruction.motion.file,
    motionLabel: instruction.motion.label,
    expression: instruction.expression.name,
    expressionLabel: instruction.expression.label,
    applied,
    why,
    line: describeInstruction(instruction),
  };
  records = [...records, record].slice(-MAX);
  // The console line is the raw proof; `applied=false` means the rig refused
  // (a missing motion/expression), which is a bug this line exposes rather than
  // hides behind "it looked fine".
  const line = `[live2d:trigger] ${record.line} · applied=${applied} · why=${why}` +
    (args.note ? ` · ${args.note}` : '') +
    ` · seq=${record.seq}`;
  if (DEBUG_ON && typeof window !== 'undefined') {
    // Bracket access: a bare `console.info` is stripped from production builds.
    const sink = (window as unknown as { console?: { info?: (msg: string) => void } }).console;
    try {
      sink?.info?.(line);
    } catch {
      /* a host that forbids console must not break the rig */
    }
    try {
      window.dispatchEvent(new CustomEvent('live2d:trigger', { detail: record }));
    } catch {
      /* very old browsers: the ring buffer is still the record of truth */
    }
  }
  listeners.forEach((fn) => fn(records));
  return record;
}

export function readTriggers(): TriggerRecord[] {
  return records;
}

export function subscribeTriggers(fn: (rows: TriggerRecord[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** States that fired at least once this page load — the probe's pass criterion. */
export function firedStates(): AgentState[] {
  const seen = new Set<AgentState>();
  records.forEach((r) => seen.add(r.state));
  return Array.from(seen);
}

/**
 * Two entries can share a motion+expression pair (thinking / skeptical). The
 * probe therefore proves per STATE, and this helper reports the distinct pairs so
 * the panel can show that the map is not accidentally collapsing into one.
 */
export function distinctPairs(): string[] {
  const pairs = new Set<string>();
  records.forEach((r) => pairs.add(`${r.motionGroup}[${r.motionIndex}]+${r.expression}`));
  return Array.from(pairs);
}
