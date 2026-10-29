/**
 * doorLanguage — which language the front door answers in.
 *
 * The door has exactly one voice worth hearing: Flux Mariana
 * (`flux-mariana-pt`, pt-BR). `language: 'en'` routes the manager to the
 * `aura-2-thalia-en` placeholder instead, so a wrong EN decision is not a
 * cosmetic bug — it is the room changing voice mid-visit.
 *
 * Deepgram nova-3 `detect_language` is not reliable enough to own that
 * decision. Measured on this rig's own clips (`~/.hermes/house/coexistir` and
 * `portal-mic-rig/house/turns.jsonl`):
 *
 *   "Mara, me dá o briefing da casa hoje?"        det=pt  conf 0.998-0.999  (right)
 *   "Mara, what is on the list today?"            det=en  conf 0.982-0.998  (right)
 *   "Hola Mara, Okay Esta Hoberto para a Casa     det=en  conf 0.941        (MISFIRE: PT)
 *    Hoggi"
 *   "Beau Ettard. Euca Sterea di Sabre que Sao    det=en  conf 0.985        (MISFIRE: PT)
 *    as Tarifa's Abertas Nacasa de coexistor..."
 *   "Do you actually see my face too, Mara?"      det=en  conf 0.82         (right, but
 *                                                                           under the old
 *                                                                           confidence floor
 *                                                                           it answered PT)
 *
 * The overlap is the point: a real English clip scored 0.941 while a garbled
 * Portuguese clip scored 0.985, so NO confidence threshold separates them. The
 * transcript text is the only signal that does. Hence:
 *
 * - the door DEFAULTS to Portuguese (the pin);
 * - provider detection still runs on every turn and its verdict is logged
 *   whenever it disagrees;
 * - English wins only with positive evidence — either an unmistakable provider
 *   verdict with no Portuguese markers, or a transcript whose words are
 *   one-sidedly English (two or more distinct English function words, at least
 *   one with no Portuguese homograph, and no Portuguese majority). Confidence
 *   is a tie-breaker, not a gate: the 0.82 probe above is clean English and
 *   must answer in English.
 *
 * An explicit caller pin (`?language=pt` / `?language=en`) still beats
 * detection: this module decides the DEFAULT, it does not forbid English.
 */

export type DoorLanguage = 'pt' | 'en';

/** The door's language when nothing better is known. Mariana speaks pt-BR. */
export const DOOR_DEFAULT_LANGUAGE: DoorLanguage = 'pt';

/**
 * What the door asks Deepgram to listen in when the caller did not pin one.
 *
 * `auto` — not `pt-BR` — is the sensible pin here. Pinning `pt-BR` makes
 * Deepgram read an English visitor through Portuguese phonetics, so the words
 * that would justify an English answer never reach the transcript; pinning
 * `en` mirrors that failure at a Portuguese front door. `multi` would be the
 * other candidate, but nova-3 multi reports a `languages` array where this
 * pipeline reads a single `detected_language`, so switching to it is a
 * `deepgramStt` change, not a door-language one. `auto` keeps detection on and
 * lets `resolveDoorLanguage` — not the provider's confidence — own the
 * answer-language decision.
 */
export const DOOR_STT_LANGUAGE = 'auto';

/**
 * Distinct English function words that make a transcript English on its own.
 * Two is the smallest count that cannot be one borrowed word ("okay",
 * "briefing") inside a Portuguese sentence; the 0.82 probe carries four.
 */
export const EN_TEXT_EVIDENCE_MIN = 2;

/** Below this, an EN detection is never trusted on its own. */
export const EN_MIN_CONFIDENCE = 0.9;

/**
 * At or above this, EN is taken at face value even if the transcript carries a
 * stray Portuguese-looking token (names like "Da Silva" score one marker).
 */
export const EN_UNMISTAKABLE_CONFIDENCE = 0.995;

/**
 * Function words that are actually diagnostic. Deliberately excludes the
 * ambiguous short forms (`a`, `e`, `o`, `as`, `os`, `de`, `me`, `no`, `um`) —
 * they appear in English chat and in names, and a false marker is what pulls an
 * English speaker onto Portuguese.
 */
const PT_MARKERS = new Set([
  'oi', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada',
  'voce', 'voces', 'nao', 'sim', 'tambem', 'hoje', 'amanha', 'agora', 'aqui',
  'casa', 'lista', 'tarefa', 'tarefas', 'aberta', 'abertas', 'aberto', 'abertos',
  'preciso', 'queria', 'quero', 'pode', 'poderia', 'como', 'quando', 'onde',
  'quem', 'porque', 'que', 'sao', 'esta', 'estao', 'estou', 'sou', 'tem',
  'tenho', 'faz', 'fazer', 'da', 'das', 'dos', 'na', 'nas', 'num', 'numa',
  'pelo', 'pela', 'para', 'com', 'isso', 'isto', 'mais', 'muito', 'bem',
  'tudo', 'nada', 'depois', 'antes', 'entao', 'sobre', 'ainda', 'ja', 'meu',
  'minha', 'nosso', 'nossa', 'seu', 'sua', 'favor', 'ajuda', 'certo', 'beleza',
  'valeu', 'tchau', 'vou', 'uma', 'ser', 'ter',
]);

const EN_MARKERS = new Set([
  'the', 'what', 'is', 'are', 'on', 'in', 'of', 'today', 'list', 'please',
  'help', 'how', 'much', 'many', 'when', 'where', 'who', 'why', 'do', 'does',
  'did', 'you', 'your', 'my', 'i', 'we', 'they', 'it', 'this', 'that', 'and',
  'or', 'not', 'yes', 'hello', 'hi', 'good', 'morning', 'evening', 'afternoon',
  'thanks', 'thank', 'there', 'here', 'now', 'later', 'want', 'need', 'can',
  'could', 'would', 'should', 'house', 'task', 'tasks', 'open', 'closed',
  'done', 'briefing', 'summary', 'tell', 'give', 'show', 'see', 'know', 'sure',
  'alright', 'okay', 'about', 'for', 'with', 'from', 'have', 'has', 'had', 'am',
  'was', 'were', 'be', 'been', 'will', 'just', 'so', 'if', 'because', 'really',
  'thing', 'things', 'going', 'gonna', 'voice', 'hear', 'listen',
]);

/** Accents that only Portuguese (among the door's two languages) uses. */
const PT_DIACRITICS = /[ãõçáâêô]/i;

/**
 * English function words with no Portuguese homograph. `do`, `so` and `for`
 * are in EN_MARKERS but are also Portuguese words ("só", "do", "for"), so a
 * short Portuguese sentence can score two EN markers without a word of English
 * in it ("É só do meu filho"). One strong marker is required before the text
 * rule may leave Portuguese.
 */
const EN_STRONG_MARKERS = new Set([
  'the', 'you', 'your', 'my', 'what', 'is', 'are', 'was', 'were', 'this',
  'that', 'they', 'we', 'not', 'yes', 'hello', 'thanks', 'thank', 'please',
  'how', 'when', 'where', 'who', 'why', 'would', 'could', 'should', 'have',
  'has', 'had', 'been', 'because', 'going', 'gonna', 'hear', 'listen', 'know',
  'sure', 'about', 'with', 'from', 'today', 'house', 'thing', 'things',
  'voice', 'morning', 'evening', 'afternoon',
]);

/** Lowercase, strip accents, split on anything that is not a letter. */
export function tokenize(text: string): string[] {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export interface LanguageEvidence {
  /** Distinct Portuguese function words (diacritics count as one extra). */
  pt: number;
  /** Distinct English function words. */
  en: number;
  /** The tokens that scored, for the log line. */
  ptTokens: string[];
  enTokens: string[];
}

/**
 * How strongly the words themselves say PT vs EN. Counted on DISTINCT tokens:
 * one "para" repeated five times is one piece of evidence, not five.
 */
export function languageEvidence(text: string): LanguageEvidence {
  const tokens = tokenize(text);
  const ptTokens: string[] = [];
  const enTokens: string[] = [];
  for (const token of tokens) {
    if (PT_MARKERS.has(token) && !ptTokens.includes(token)) ptTokens.push(token);
    if (EN_MARKERS.has(token) && !enTokens.includes(token)) enTokens.push(token);
  }
  const diacritic = PT_DIACRITICS.test(text || '') ? 1 : 0;
  return {
    pt: ptTokens.length + diacritic,
    en: enTokens.length,
    ptTokens,
    enTokens,
  };
}

export type DoorLanguageReason =
  /** Caller pinned a language (`?language=pt|en`); detection was not consulted. */
  | 'requested'
  /** Provider said PT. */
  | 'detected-pt'
  /** Provider said EN and nothing contradicted it. */
  | 'detected-en'
  /** Provider said EN, but the words are Portuguese — the known misfire. */
  | 'pt-evidence'
  /** Provider's EN verdict was not confident enough to leave the door language. */
  | 'low-confidence'
  /** Provider said something the voice matrix cannot speak (ko, es, ...). */
  | 'unsupported-detection'
  /** Nothing usable came back; the door keeps its own language. */
  | 'default';

export interface DoorLanguageDecision {
  /** What the door will answer in. */
  language: DoorLanguage;
  /** What the provider alone would have produced for the turn language. */
  detectedTurnLanguage: DoorLanguage | null;
  /** Raw provider tag (`pt`, `en`, `ko`, ...). */
  detected: string | null;
  confidence: number | null;
  reason: DoorLanguageReason;
  /** True when detection said EN and the door held Portuguese instead. */
  overridden: boolean;
  evidence: LanguageEvidence;
}

export interface ResolveDoorLanguageInput {
  /** Raw provider detection, e.g. `en`. */
  detected?: string | null;
  /** Provider `language_confidence` (0..1) when it sent one. */
  confidence?: number | null;
  /** The transcript — what the provider says was said. */
  text?: string | null;
  /**
   * A caller's explicit pin (`?language=pt|en|pt-BR|...`). Anything else,
   * including `auto` and empty, means "detect".
   */
  requested?: string | null;
}

function toDoorLanguage(tag: string | null | undefined): DoorLanguage | null {
  const value = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!value) return null;
  if (value.startsWith('pt')) return 'pt';
  if (value.startsWith('en')) return 'en';
  return null;
}

/**
 * The `/stt` language hint for one clip.
 *
 * No pin (or `auto`) means "listen in the door's own setting": detection stays
 * on, so the provider still reports what it heard and `resolveDoorLanguage` can
 * override it. A caller's explicit tag passes through untouched — that is the
 * only case where the provider is told a language in advance.
 */
export function sttLanguageFor(requested?: string | null): string {
  const value = typeof requested === 'string' ? requested.trim() : '';
  if (!value || value.toLowerCase() === 'auto') return DOOR_STT_LANGUAGE;
  return value;
}

/**
 * Decide the door's answer language for one clip.
 *
 * Default-closed on purpose: every path that is not positive EN evidence ends
 * on Portuguese, because the cost of a wrong EN is the room losing Mariana and
 * the cost of a wrong PT is a Portuguese-sounding English answer at a
 * Portuguese front door.
 */
export function resolveDoorLanguage(input: ResolveDoorLanguageInput): DoorLanguageDecision {
  const evidence = languageEvidence(input.text ?? '');
  const detected = typeof input.detected === 'string' ? input.detected.trim().toLowerCase() || null : null;
  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? input.confidence
      : null;
  const detectedTurnLanguage = toDoorLanguage(detected);

  const requestedRaw =
    typeof input.requested === 'string' ? input.requested.trim().toLowerCase() : '';
  const requested = requestedRaw && requestedRaw !== 'auto' ? toDoorLanguage(requestedRaw) : null;

  const base = { detected, confidence, evidence };

  // An explicit pin wins: the door decides defaults, it does not override asks.
  if (requested) {
    return {
      ...base,
      language: requested,
      detectedTurnLanguage,
      reason: 'requested',
      overridden: false,
    };
  }

  if (detectedTurnLanguage === 'pt') {
    return { ...base, language: 'pt', detectedTurnLanguage, reason: 'detected-pt', overridden: false };
  }

  if (detectedTurnLanguage !== 'en') {
    return {
      ...base,
      language: DOOR_DEFAULT_LANGUAGE,
      detectedTurnLanguage,
      reason: detected ? 'unsupported-detection' : 'default',
      overridden: false,
    };
  }

  // From here the provider said EN. The words decide; confidence only breaks
  // ties it cannot settle alone (0.941 English vs 0.985 Portuguese on this rig).
  const unmistakable = confidence !== null && confidence >= EN_UNMISTAKABLE_CONFIDENCE;
  if (unmistakable && evidence.pt <= 1) {
    return { ...base, language: 'en', detectedTurnLanguage, reason: 'detected-en', overridden: false };
  }

  // The text contradicts the provider ("Hola Mara, Okay Esta Hoberto para a
  // Casa Hoggi" — det=en 0.941, three PT markers): keep Mariana.
  if (evidence.pt > evidence.en) {
    return { ...base, language: 'pt', detectedTurnLanguage, reason: 'pt-evidence', overridden: true };
  }

  // One-sided English words win at any confidence. "Do you actually see my
  // face too, Mara?" came back det=en 0.82 — four English function words, no
  // Portuguese ones — and the old `confidence >= 0.9` gate answered it in
  // Portuguese. A transcript that is unmistakably English is the evidence; the
  // provider's confidence is not. The strong-marker test keeps a short
  // Portuguese sentence made of homographs ("só do meu filho") on Portuguese.
  const strongEnglish = evidence.enTokens.some((token) => EN_STRONG_MARKERS.has(token));
  if (evidence.en >= EN_TEXT_EVIDENCE_MIN && evidence.en > evidence.pt && strongEnglish) {
    return { ...base, language: 'en', detectedTurnLanguage, reason: 'detected-en', overridden: false };
  }

  // One English word with no Portuguese markers still needs a plausible
  // provider verdict; alone it could be a loanword ("okay", "briefing").
  const confidentEnough = confidence !== null && confidence >= EN_MIN_CONFIDENCE;
  if (confidentEnough && evidence.en > 0 && evidence.pt === 0) {
    return { ...base, language: 'en', detectedTurnLanguage, reason: 'detected-en', overridden: false };
  }

  return {
    ...base,
    language: DOOR_DEFAULT_LANGUAGE,
    detectedTurnLanguage,
    reason: confidence !== null && confidence < EN_MIN_CONFIDENCE ? 'low-confidence' : 'pt-evidence',
    overridden: true,
  };
}

/** One line for the server log — only warns when the provider was overruled. */
export function describeDoorLanguage(decision: DoorLanguageDecision): string {
  const conf = decision.confidence === null ? 'n/a' : decision.confidence.toFixed(3);
  const evidence = `pt=${decision.evidence.pt} en=${decision.evidence.en}`;
  return (
    `[coexistirVoice] door language ${decision.language.toUpperCase()} ` +
    `(provider ${decision.detected ?? 'none'} conf ${conf}, ${evidence}, reason ${decision.reason})`
  );
}
