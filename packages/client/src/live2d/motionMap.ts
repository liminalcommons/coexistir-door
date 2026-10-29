/**
 * motionMap — Mao's REAL motion/expression inventory, and the ONE table the
 * door uses to turn an agent state into a face and a gesture.
 *
 * Why this file exists: the first rig picked motions by array index from
 * `sentiment.ts` (happy → TapBody 0, sad → TapBody 4, …). Those indices were
 * arbitrary — they came from the order of the entries in Mao.model3.json, not
 * from anything the model actually does — so "sad" could as easily have been a
 * rainbow explosion. This module replaces guesswork with an INVENTORY read from
 * the shipped model files and a state map that names, for every state, the
 * motion file and the expression file that state uses.
 *
 * Inventory source (packages/client/public/live2d/models/mao/):
 *   Mao.model3.json → Motions: { Idle: [mtn_01, sample_01], TapBody: [mtn_02,
 *   mtn_03, mtn_04, special_01, special_02, special_03] }, Expressions:
 *   exp_01..exp_08. Cubism addresses a motion by GROUP + INDEX, so an inventory
 *   row is (group, index) plus the file that index resolves to.
 *
 * Labels are not invented: each one is the dominant, measured content of the
 * motion's curves (see `evidence`) — e.g. mtn_04 peaks at ParamArmLB01 −30..19
 * and ParamHatForm 0..21, i.e. the free arm and the hat move together: a hat
 * flourish, the closest thing Mao has to a wave. Expressions are labelled from
 * their own parameter payload (exp_05 drives brow-angle −1 + mouthDown +1: the
 * sad face), not from their file order.
 *
 * This file is pure data + pure functions: no DOM, no Cubism, unit-testable.
 */

/** Cubism motion groups Mao actually ships. Nothing else can be played. */
export type MotionGroup = 'Idle' | 'TapBody';

export interface MotionRef {
  /** Motion group, as named in Mao.model3.json. */
  group: MotionGroup;
  /** Index inside that group — what the Cubism motion manager takes. */
  index: number;
  /** The file that (group, index) resolves to, relative to the model dir. */
  file: string;
  /** Seconds, from the motion's own Meta.Duration. */
  durationMs: number;
  /** What the curves do, in one line. */
  label: string;
  /** The measured evidence for the label. */
  evidence: string;
}

/**
 * All eight motions Mao ships. Ids are stable internal names; the model's own
 * file names are kept so a log line can be checked against the payload.
 */
export const MAO_MOTIONS = {
  breath: {
    group: 'Idle',
    index: 0,
    file: 'motions/mtn_01.motion3.json',
    durationMs: 5570,
    label: 'idle breath + ink drip',
    evidence:
      'head/body sway ±4–6°, ParamInkDrop 0..30 with InkDropOn, blink curve; no arm gesture',
  },
  shimmer: {
    group: 'Idle',
    index: 1,
    file: 'motions/sample_01.motion3.json',
    durationMs: 5570,
    label: 'idle breath + magic shimmer',
    evidence:
      'same body sway as mtn_01 plus ParamSphereMove −1..1 and Sphere colours 0..29.95 (a glow pass)',
  },
  nod: {
    group: 'TapBody',
    index: 0,
    file: 'motions/mtn_02.motion3.json',
    durationMs: 3470,
    label: 'nod / small bow',
    evidence:
      'ParamAngleY −19..7 with both shoulders −6 and hands curling −10: a downward nod, no magic',
  },
  tilt: {
    group: 'TapBody',
    index: 1,
    file: 'motions/mtn_03.motion3.json',
    durationMs: 4400,
    label: 'head tilt + arm swing',
    evidence:
      'ParamAngleZ ±15 and BodyAngleZ ±10 (a roll), arms swinging −20..13, wand rotate 0..7.2',
  },
  flourish: {
    group: 'TapBody',
    index: 2,
    file: 'motions/mtn_04.motion3.json',
    durationMs: 4200,
    label: 'hat flourish (wave)',
    evidence:
      'free arm ParamArmLB01 −30..19 + HatForm 0..21 + head nod −23..26: hand to the hat and out',
  },
  heal: {
    group: 'TapBody',
    index: 3,
    file: 'motions/special_01.motion3.json',
    durationMs: 7800,
    label: 'aura + heal light',
    evidence:
      'right arm raise with ParamAura 0..29.3, HeartLight/HealLight 0..30 (a soft glow, no blast)',
  },
  burst: {
    group: 'TapBody',
    index: 4,
    file: 'motions/special_02.motion3.json',
    durationMs: 9370,
    label: 'rainbow spark burst',
    evidence:
      'ParamExplosion 0..30, Smoke 0..30, WandInkColorRainbow 0..34.3, HeartColorRainbow 0..29.3',
  },
  poof: {
    group: 'TapBody',
    index: 5,
    file: 'motions/special_03.motion3.json',
    durationMs: 9230,
    label: 'rabbit summon / poof',
    evidence:
      'ParamRabbitAppearance + RabbitElimination 0..30 with Aura 0..29.3: a prop appears and vanishes',
  },
} as const satisfies Record<string, MotionRef>;

export type MotionId = keyof typeof MAO_MOTIONS;

export const MOTION_IDS = Object.keys(MAO_MOTIONS) as MotionId[];

export interface ExpressionRef {
  /** File stem, as named in Mao.model3.json (this is the Cubism name). */
  name: string;
  file: string;
  label: string;
  /** The parameters the expression actually drives. */
  evidence: string;
}

/**
 * All eight expressions Mao ships, labelled from their payload. exp_03 is the
 * closed-eye rest face; it is NOT "neutral" (that is exp_01, which is all
 * zeroes) — the first rig booted on exp_03, which is why Mara opened her eyes
 * only after the first turn.
 */
export const MAO_EXPRESSIONS = {
  neutral: {
    name: 'exp_01',
    file: 'expressions/exp_01.exp3.json',
    label: 'neutral (reset)',
    evidence: 'every parameter 0 with EyeOpen ×1: the untouched face',
  },
  smile: {
    name: 'exp_02',
    file: 'expressions/exp_02.exp3.json',
    label: 'warm smile',
    evidence: 'EyeLSmile/EyeRSmile 1, EyeOpen ×0 (closed happy eyes)',
  },
  rest: {
    name: 'exp_03',
    file: 'expressions/exp_03.exp3.json',
    label: 'eyes closed (rest)',
    evidence: 'EyeOpen ×0 and nothing else: the blink/rest face',
  },
  sparkle: {
    name: 'exp_04',
    file: 'expressions/exp_04.exp3.json',
    label: 'sparkle eyes',
    evidence: 'EyeOpen ×1.2, EyeSmile 1, ParamEyeEffect 1',
  },
  sad: {
    name: 'exp_05',
    file: 'expressions/exp_05.exp3.json',
    label: 'sad',
    evidence: 'BrowAngle −1, BrowForm −1, MouthUp −1, MouthDown +1',
  },
  shy: {
    name: 'exp_06',
    file: 'expressions/exp_06.exp3.json',
    label: 'shy (blush)',
    evidence: 'ParamCheek 1 with brows angled −1 and a flat mouth',
  },
  think: {
    name: 'exp_07',
    file: 'expressions/exp_07.exp3.json',
    label: 'pondering / unconvinced',
    evidence: 'EyeOpen ×1.2, EyeBallForm −1 (narrowed), BrowForm +1, mouth down',
  },
  pout: {
    name: 'exp_08',
    file: 'expressions/exp_08.exp3.json',
    label: 'pout / annoyed',
    evidence: 'EyeForm 1, MouthAngry 1 + MouthAngryLine 1, MouthUp −1',
  },
} as const satisfies Record<string, ExpressionRef>;

export type ExpressionId = keyof typeof MAO_EXPRESSIONS;

export const EXPRESSION_IDS = Object.keys(MAO_EXPRESSIONS) as ExpressionId[];

/**
 * The agent states the door can be in. `sad|shy|skeptical|angry|happy|excited`
 * are the sentiment states; the rest are the pipeline's own beats.
 */
export type AgentState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'greeting'
  | 'happy'
  | 'excited'
  | 'sad'
  | 'shy'
  | 'skeptical'
  | 'angry'
  | 'bargeIn';

export interface StateCue {
  /** Whether the motion is started once (a beat) or left to the Idle loop. */
  beat: 'once' | 'loop';
  motion: MotionId;
  expression: ExpressionId;
  /**
   * Leave whatever face the answer earned in place (only `speaking` sets this):
   * starting a talk beat with a blank face would wipe the emotion a turn just
   * produced, which is the "her face resets mid-sentence" bug in map form.
   */
  keepFace?: boolean;
}

/**
 * THE MAP. Every state names a motion from the inventory above and an
 * expression from the inventory above — no indices, no randomness, no
 * "default to 0".
 *
 * Rationale per row:
 *   idle      breathing loop, neutral face — the resting door.
 *   listening the nod: she acknowledges that the ear is open, then idles.
 *   thinking  the head tilt + narrowed eyes: physically weighing the answer.
 *   speaking  the breathing loop (a beat motion would fight the lip sync) and
 *             the emotion expression is NOT overwritten here — `speaking`
 *             keeps whatever face the answer earned.
 *   greeting  the hat flourish is Mao's wave, with the warm smile.
 *   happy     a nod with the smile: pleased agreement.
 *   excited   the rainbow burst + sparkle eyes (the loudest thing she has).
 *   sad       the quiet shimmer idle + sad face: no gesture, she goes still.
 *   shy       the soft aura/heal glow + blush: a small, warm gesture.
 *   skeptical the tilt + pondering face: the same physical language as
 *             thinking, different state name in the log (deliberate: there is
 *             only one "weighing" motion and pretending otherwise would be a
 *             lie about the inventory).
 *   angry     the rabbit poof + pout: a prop vanishes, which is as close to a
 *             huff as this model gets.
 *   bargeIn   cut to the nod + neutral face: she stops and gives the floor
 *             back. `cut` is executed before the beat is played.
 */
export const AGENT_STATE_MAP: Record<AgentState, StateCue> = {
  idle: { beat: 'loop', motion: 'breath', expression: 'neutral' },
  listening: { beat: 'once', motion: 'nod', expression: 'neutral' },
  thinking: { beat: 'once', motion: 'tilt', expression: 'think' },
  speaking: { beat: 'loop', motion: 'breath', expression: 'neutral', keepFace: true },
  greeting: { beat: 'once', motion: 'flourish', expression: 'smile' },
  happy: { beat: 'once', motion: 'nod', expression: 'smile' },
  excited: { beat: 'once', motion: 'burst', expression: 'sparkle' },
  sad: { beat: 'loop', motion: 'shimmer', expression: 'sad' },
  shy: { beat: 'once', motion: 'heal', expression: 'shy' },
  skeptical: { beat: 'once', motion: 'tilt', expression: 'think' },
  angry: { beat: 'once', motion: 'poof', expression: 'pout' },
  bargeIn: { beat: 'once', motion: 'nod', expression: 'neutral' },
};

export const AGENT_STATES = Object.keys(AGENT_STATE_MAP) as AgentState[];

/** The sentiment subset, in the order the panel lists it. */
export const SENTIMENT_STATES = ['happy', 'excited', 'sad', 'shy', 'skeptical', 'angry'] as const;

/** A fully resolved instruction for the rig, plus the line the log prints. */
export interface StageInstruction {
  state: AgentState;
  beat: 'once' | 'loop';
  motion: MotionRef;
  motionId: MotionId;
  expression: ExpressionRef;
  expressionId: ExpressionId;
}

/**
 * Resolve a state to the model's own vocabulary. Pure: the rig and the tests
 * call the same function, so a log line and a screenshot cannot disagree.
 */
export function instructionFor(state: AgentState): StageInstruction {
  const cue = AGENT_STATE_MAP[state];
  const motion = MAO_MOTIONS[cue.motion];
  const expression = MAO_EXPRESSIONS[cue.expression];
  return {
    state,
    beat: cue.beat,
    motion,
    motionId: cue.motion,
    expression,
    expressionId: cue.expression,
  };
}

/** One-line proof line, printed to the console and shown in the rail. */
export function describeInstruction(instruction: StageInstruction): string {
  const { state, beat, motion, expression } = instruction;
  return (
    `state=${state} · ${beat} · motion ${motion.group}[${motion.index}] ` +
    `${motion.file.split('/').pop()} (${motion.label}) · expression ${expression.name} (${expression.label})`
  );
}

/** The console prefix every trigger line carries. One grep finds them all. */
export const TRIGGER_PREFIX = '[live2d:trigger]';

/**
 * Inventory sanity: the map may only reference motions/expressions that exist
 * in the shipped model. Called by the stage on boot and asserted by the tests.
 */
export function unknownMapEntries(): string[] {
  const problems: string[] = [];
  for (const state of AGENT_STATES) {
    const cue = AGENT_STATE_MAP[state];
    if (!(cue.motion in MAO_MOTIONS)) problems.push(`${state}: unknown motion ${cue.motion}`);
    if (!(cue.expression in MAO_EXPRESSIONS)) {
      problems.push(`${state}: unknown expression ${cue.expression}`);
    }
  }
  return problems;
}
