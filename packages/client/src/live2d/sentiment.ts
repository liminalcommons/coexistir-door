/**
 * sentiment — keyword rules v1 for turning a manager turn into a stage cue.
 *
 * The manager (Mara) already composes real turns server-side; there is no
 * model call in the browser. This module is deliberately dumb and testable:
 * normalize (lowercase, strip accents), count keyword hits per emotion, and
 * fall back to the turn's intent when the text is emotionally flat. The
 * result is a table row the Live2D stage can execute — an AGENT STATE whose
 * expression + motion come from `motionMap.ts`.
 *
 * The mapping is data, not behaviour: this file no longer picks a motion index.
 * It decides WHICH emotion the words carry; `motionMap.ts` owns which motion
 * file and expression that emotion wears. Sentiment is a text problem, the face
 * is a model problem, and keeping them apart is what makes the rig auditable.
 */

import {
  AGENT_STATE_MAP,
  MAO_EXPRESSIONS,
  MAO_MOTIONS,
  type AgentState,
  type ExpressionId,
  type MotionId,
} from './motionMap';

export type Emotion = 'neutral' | 'happy' | 'excited' | 'sad' | 'shy' | 'skeptical' | 'angry';

export type ManagerIntentLike = 'greeting' | 'briefing' | 'todos' | 'reflection' | string | undefined;

export interface StageCue {
  /** The door state this cue puts the rig in (the map's own vocabulary). */
  state: AgentState;
  emotion: Emotion;
  /** Cubism expression name, resolved from the inventory. */
  expression: string;
  /** `Idle` or `TapBody`: the group the resolved motion lives in. */
  motionGroup: 'Idle' | 'TapBody';
  /**
   * TapBody index, or null when the cue is a loop (idle/breath). Kept for the
   * in-room stage, which only ever played TapBody beats.
   */
  motionIndex: number | null;
  /** The motion file the rig will actually play (proof lives in the log). */
  motionFile: string;
  /** 0..1 — used to scale the expression hold time / log confidence. */
  intensity: number;
  /** Human-readable reasons, for the debug hook and the console. */
  matched: string[];
}

interface EmotionRule {
  emotion: Emotion;
  /** Normalized (accent-free, lowercase) substrings. */
  keywords: string[];
  /** Extra weight so a rare, specific word beats a generic one. */
  weight?: number;
}

/** Emotion → agent state. `neutral` means "no mood": the door's own state wins. */
export const STATE_BY_EMOTION: Readonly<Record<Emotion, AgentState | null>> = {
  neutral: null,
  happy: 'happy',
  excited: 'excited',
  sad: 'sad',
  shy: 'shy',
  skeptical: 'skeptical',
  angry: 'angry',
};

/**
 * The two tables below are DERIVED from the map, never hand-written: a change in
 * `motionMap.ts` flows through here, so the in-room stage and the door cannot
 * disagree about what "sad" looks like.
 */
export const EXPRESSION_BY_EMOTION: Readonly<Record<Emotion, string>> = (() => {
  const out = {} as Record<Emotion, string>;
  (Object.keys(STATE_BY_EMOTION) as Emotion[]).forEach((emotion) => {
    const state = STATE_BY_EMOTION[emotion] ?? 'idle';
    out[emotion] = MAO_EXPRESSIONS[AGENT_STATE_MAP[state].expression].name;
  });
  return out;
})();

export const MOTION_BY_EMOTION: Readonly<Record<Emotion, number | null>> = (() => {
  const out = {} as Record<Emotion, number | null>;
  (Object.keys(STATE_BY_EMOTION) as Emotion[]).forEach((emotion) => {
    const state = STATE_BY_EMOTION[emotion] ?? 'idle';
    const motion = MAO_MOTIONS[AGENT_STATE_MAP[state].motion];
    out[emotion] = motion.group === 'TapBody' ? motion.index : null;
  });
  return out;
})();

const INTENT_BASELINE: Readonly<Record<string, Emotion>> = {
  greeting: 'happy',
  briefing: 'neutral',
  todos: 'skeptical',
  reflection: 'shy',
};

const RULES: EmotionRule[] = [
  {
    emotion: 'excited',
    weight: 2,
    keywords: [
      'incrivel', 'otimo', 'otima', 'maravilh', 'excelente', 'parabens', 'conseguimos',
      'uau', 'eba', 'vamos la', 'awesome', 'amazing', 'excellent', 'congrat', 'we did it',
      'brilliant', 'perfect',
    ],
  },
  {
    // Salutations are weak signals: they open almost every turn, so they must
    // not outrank a real emotional word or override a non-greeting intent.
    emotion: 'happy',
    weight: 0.4,
    keywords: [
      'bom dia', 'boa tarde', 'boa noite', 'ola', 'oi ', 'oi!', 'bem-vind', 'welcome',
      'hello', 'good morning', 'good evening', 'hi ',
    ],
  },
  {
    emotion: 'happy',
    keywords: [
      'que bom', 'feliz', 'alegr', 'obrigad', 'gostei', 'tudo bem',
      'glad', 'happy', 'thanks', 'thank you', 'great', 'nice', 'lovely',
    ],
  },
  {
    emotion: 'sad',
    weight: 1.5,
    keywords: [
      'infelizmente', 'sinto muito', 'preocup', 'dificil', 'cansad', 'triste',
      'atrasad', 'esquec', 'perdemos', 'falhou', 'unfortunately', 'sorry', 'sad', 'worried',
      'difficult', 'tired', 'missed', 'failed', 'behind',
    ],
  },
  {
    emotion: 'angry',
    weight: 2,
    keywords: [
      'raiva', 'irritad', 'inaceitavel', 'absurdo', 'nao pode', 'chega', 'pare', 'culpa',
      'angry', 'furious', 'unacceptable', 'stop it', 'enough',
    ],
  },
  {
    emotion: 'shy',
    keywords: [
      'desculp', 'com licenca', 'por favor', 'humild', 'timid', 'espero que', 'tomara',
      'sorry to', 'please', 'hope', 'if you like', 'no pressure',
    ],
  },
  {
    // A question mark is a hint, not a mood: it must not beat the intent
    // baseline on its own (the manager ends most turns with a question).
    emotion: 'skeptical',
    weight: 0.35,
    keywords: ['?'],
  },
  {
    emotion: 'skeptical',
    keywords: [
      'talvez', 'nao sei', 'sera', 'hmm', 'pensar', 'revisar', 'conferir', 'cuidado',
      'atencao', 'duvida', 'maybe', 'not sure', 'perhaps', 'think about', 'review',
      'check', 'careful',
    ],
  },
];

/** Lowercase + strip combining accents so PT and EN keywords share one table. */
export function normalize(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function countHits(haystack: string, needle: string): number {
  if (!needle) return 0;
  // '?' is a punctuation signal, not a word: plain includes is correct there.
  if (needle === '?') return haystack.includes('?') ? 1 : 0;
  let hits = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const before = at === 0 ? ' ' : haystack[at - 1];
    const after = haystack[at + needle.length] ?? ' ';
    // Word-ish boundary: keywords are prefixes ('preocup' matches 'preocupada'),
    // so only the left edge must not be a letter.
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
      hits += 1;
      if (needle.length > 6) return hits; // one hit per long keyword is plenty
    }
    from = at + needle.length;
  }
  return hits;
}

/** Build the cue for one emotion, using the inventory for the face/gesture. */
export function cueForEmotion(
  emotion: Emotion,
  intensity: number,
  matched: string[] = [],
): StageCue {
  const state = STATE_BY_EMOTION[emotion] ?? 'idle';
  const cue = AGENT_STATE_MAP[state];
  const motion = MAO_MOTIONS[cue.motion];
  const expression = MAO_EXPRESSIONS[cue.expression];
  return {
    state,
    emotion,
    expression: expression.name,
    motionGroup: motion.group,
    motionIndex: motion.group === 'TapBody' ? motion.index : null,
    motionFile: motion.file,
    intensity,
    matched,
  };
}

/**
 * Classify one manager turn. Pure: no DOM, no clock — the unit tests pin it.
 */
export function classifyTurn(text: string, intent?: ManagerIntentLike): StageCue {
  const haystack = normalize(text);
  const scores = new Map<Emotion, number>();
  const matched: string[] = [];

  for (const rule of RULES) {
    let score = 0;
    for (const keyword of rule.keywords) {
      const hits = countHits(haystack, keyword);
      if (hits > 0) {
        score += hits * (rule.weight ?? 1);
        matched.push(keyword.trim());
      }
    }
    if (score > 0) scores.set(rule.emotion, (scores.get(rule.emotion) ?? 0) + score);
  }

  let emotion: Emotion = INTENT_BASELINE[intent ?? ''] ?? 'neutral';
  let best = 0;
  scores.forEach((score, candidate) => {
    if (score > best) {
      best = score;
      emotion = candidate;
    }
  });
  // A single weak hit (e.g. "boa tarde") is not a mood: fall back to intent.
  if (best < 0.5) emotion = INTENT_BASELINE[intent ?? ''] ?? 'neutral';

  const exclamations = (text.match(/!/g) || []).length;
  const intensity = Math.max(0.35, Math.min(1, 0.45 + best * 0.15 + exclamations * 0.1));

  // The face/gesture come from the inventory, not from this file.
  const cue = cueForEmotion(emotion, Number(intensity.toFixed(2)));
  return {
    state: cue.state,
    emotion,
    expression: cue.expression,
    motionGroup: cue.motionGroup,
    motionIndex: cue.motionIndex,
    motionFile: cue.motionFile,
    intensity: Number(intensity.toFixed(2)),
    matched: Array.from(new Set(matched)).slice(0, 8),
  };
}

/** Everything the panel needs to explain a motion id (for the trigger card). */
export function motionLabelOf(id: MotionId): string {
  return `${MAO_MOTIONS[id].group}[${MAO_MOTIONS[id].index}] ${MAO_MOTIONS[id].label}`;
}

export function expressionLabelOf(id: ExpressionId): string {
  return `${MAO_EXPRESSIONS[id].name} · ${MAO_EXPRESSIONS[id].label}`;
}
