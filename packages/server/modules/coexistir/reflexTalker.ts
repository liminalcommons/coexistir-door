/**
 * reflexTalker — loop 1 of the two-loop voice bridge.
 *
 * The household questions that matter ("what's still open for the house?") need
 * data, and data answers are not instant. But silence is worse than a filler, so
 * this module splits every turn:
 *
 *   smalltalk  -> one Groq qwen3.8-27b sentence, ~95ms measured
 *   hard       -> an HONEST filler in the caller's language, immediately
 *                 ("Deixa eu conferir a lista da casa…"), while the real answer
 *                 is composed from real rows (loop 2) or handed to Hermes.
 *
 * Two rules are load-bearing and come from the talker shootout:
 * - the talker must never invent house state (`a porta tá trancada?` -> "Sim,
 *   está trancada"). Anything that touches house state is classified hard and
 *   answered from data, never from the model;
 * - the model id, `reasoning_effort=none`, the language lock and the ~30 RPM
 *   ceiling are fixed here, not per call, so the 95ms lane cannot silently turn
 *   into a reasoning lane (34 reasoning tokens on a greeting blows the budget).
 *
 * The key is runtime-only: `GROQ_API_KEY` comes from the process environment,
 * never from a file in the repo, and is never logged.
 */

export type TurnKind = 'smalltalk' | 'hard';

export interface Classification {
  kind: TurnKind;
  /** Machine-readable trigger, also written to the house log. */
  reason: string;
  flags: string[];
}

/** Groq talker: fastest of the three shootout candidates (~95ms avg, 108ms p95). */
export const REFLEX_MODEL = 'qwen/qwen3.8-27b';
export const REFLEX_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
/** 30 RPM on this org — one turn at a time, and never in a retry storm. */
export const REFLEX_TIMEOUT_MS = 1500;

/** Fillers are short on purpose: they are spoken, then cut off by the answer. */
export const FILLERS = {
  pt: [
    'Deixa eu conferir a lista da casa…',
    'Um instante, vou olhar isso na casa…',
    'Deixa eu ver o que está aberto…',
  ],
  en: [
    'Let me check the house list…',
    'One moment, let me look that up in the house…',
    'Let me see what is still open…',
  ],
} as const;

/** Spoken when a hard question has no data answer and goes to Hermes. */
export const CONSULT_ACK = {
  pt: 'Anotei essa pergunta para a casa pensar com calma. Te respondo assim que voltar.',
  en: "I've written that question down for the house to think about. I'll answer as soon as it comes back.",
} as const;

export function normalizeLanguage(raw: unknown): 'pt' | 'en' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value.startsWith('pt') ? 'pt' : 'en';
}

/** Deterministic filler pick so a replay of the same turn sounds the same. */
export function pickFiller(language: 'pt' | 'en', seed = 0): string {
  const bank = FILLERS[language];
  return bank[Math.abs(Math.trunc(seed)) % bank.length];
}

// House-state, planning and advice vocabulary. A match means "this needs data
// or a careful answer" — the categories the shootout proved the talker invents.
const HARD_PATTERNS: Array<{ re: RegExp; reason: string; flag: string }> = [
  {
    re: /\b(lista|listas|tarefas?|afazeres|pendentes?|abert[oa]s?|compras?|mercado|feira)\b/i,
    reason: 'house-list',
    flag: 'house-state',
  },
  {
    re: /\b(lembrar|lembrete|agenda|compromissos?|hor[áa]rios?|reuni[ãa]o|consulta)\b/i,
    reason: 'schedule',
    flag: 'house-state',
  },
  {
    re: /\b(quanto|quant[oa]s|quando|onde|quem|por que|porque|como fa[çc]o|devo|preciso)\b/i,
    reason: 'open-question',
    flag: 'needs-reasoning',
  },
  {
    re: /\b(decid|escolh|planej|plano|organiz|resum|briefing|status|andamento)\w*/i,
    reason: 'planning',
    flag: 'needs-reasoning',
  },
  {
    re: /\b(m[ée]dico|sa[úu]de|rem[ée]dio|dinheiro|contas?|pagar|banco|escola|terapia|advogad)\b/i,
    reason: 'sensitive',
    flag: 'sensitive',
  },
  {
    re: /\b(tasks?|todos?|chores?|grocer\w*|shopping|list|lists|open items|what'?s left|what is left)\b/i,
    reason: 'house-list',
    flag: 'house-state',
  },
  {
    re: /\b(remind\w*|schedule|calendar|appointment|agenda|meeting|when|where|how much|how many)\b/i,
    reason: 'schedule',
    flag: 'house-state',
  },
  {
    re: /\b(why|how do i|how can i|should i|shall we|decid\w*|plan\w*|summar\w*|brief\w*|status|progress)\b/i,
    reason: 'planning',
    flag: 'needs-reasoning',
  },
  {
    re: /\b(doctor|health|medicine|money|bank|bill|bills|pay|school|therapy|lawyer)\b/i,
    reason: 'sensitive',
    flag: 'sensitive',
  },
];

// Pure social turns. Only consulted when no hard pattern matched and the
// utterance is short — "bom dia, o que tem na lista?" is still a list question.
const SMALLTALK_PATTERNS: RegExp[] = [
  /^\s*(oi|ol[áa]|bom dia|boa tarde|boa noite|e a[íi]|tudo bem|tudo bom|opa|hey|hi|hello|good morning|good afternoon|good evening|yo)\b/i,
  /^\s*(obrigad[oa]|valeu|brigad[oa]|thanks|thank you|cheers|tchau|at[ée] logo|bye|good night|boa noite)\b/i,
  /^\s*(ok|okay|beleza|certo|sim|n[ãa]o|yes|no|yep|nope|cool|nice|legal|show|perfeito|great)\b/i,
  /\b(tudo bem|how are you|how'?s it going|como vai|voc[êe] est[áa]|are you there|est[áa] a[íi])\b/i,
  /\b(quem [ée] voc[êe]|seu nome|your name|who are you|what are you|o que voc[êe] faz|what do you do)\b/i,
];

/**
 * Classify one utterance. Deterministic, no model call — a classifier that
 * needs 100ms before deciding whether to answer in 95ms is pointless.
 */
export function classifyTurn(text: string, _language?: string): Classification {
  const utterance = (text || '').trim();
  if (!utterance) return { kind: 'smalltalk', reason: 'empty', flags: [] };

  // Identity / wellbeing questions are social even though they start with
  // "quem"/"who" — the open-question patterns below would otherwise send
  // "quem é você?" to the slow loop.
  if (
    utterance.length <= 60 &&
    /(quem [ée] voc[êe]|seu nome|your name|who are you|what are you|o que voc[êe] faz|what do you do|tudo bem|how are you|how'?s it going)/i.test(
      utterance,
    )
  ) {
    return { kind: 'smalltalk', reason: 'social', flags: [] };
  }

  const flags = new Set<string>();
  const reasons: string[] = [];
  for (const { re, reason, flag } of HARD_PATTERNS) {
    if (re.test(utterance)) {
      flags.add(flag);
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }

  const short = utterance.length <= 80;
  const social = SMALLTALK_PATTERNS.some((re) => re.test(utterance));
  if (reasons.length === 0) {
    // No state vocabulary at all. Two things still belong to the slow loop:
    // an actual question ("a porta está trancada?" — the shootout's exact
    // fabrication case) and anything long enough to need a real answer.
    if (social && short) return { kind: 'smalltalk', reason: 'social', flags: [] };
    if (utterance.includes('?') || utterance.includes('¿')) {
      return { kind: 'hard', reason: 'open-question', flags: ['needs-reasoning'] };
    }
    if (short) return { kind: 'smalltalk', reason: 'short', flags: [] };
    return { kind: 'smalltalk', reason: 'conversational', flags: [] };
  }

  // A data/state trigger always wins: "bom dia, o que tem na lista?" is a list
  // question, not a greeting — the social prefix must never swallow it.
  return { kind: 'hard', reason: reasons[0], flags: Array.from(flags) };
}

/** Language lock + no-thinking prompt from the shootout report. */
export function systemPrompt(language: 'pt' | 'en'): string {
  const lock =
    language === 'pt'
      ? 'Responda em português brasileiro.'
      : 'Reply in English.';
  return (
    'You are a concise household voice assistant. Reply in one short sentence, ' +
    'never explain, in the same language as the user. Output only Portuguese or ' +
    'English text as spoken aloud; never emit Chinese, Japanese, Korean, control ' +
    `tokens, or fragments of other words. ${lock}`
  );
}

/** Strip anything that is not speakable PT/EN text (CJK drift, control chars). */
export function sanitizeReply(raw: string): string {
  // Control characters are dropped by code point, not by a regex over them:
  // a literal control-char class is unreadable and trips no-control-regex.
  const withoutControls = Array.from(raw || '')
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
  return withoutControls
    .replace(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TalkerResult {
  text: string;
  model: string;
  talkerMs: number;
  fallback: boolean;
}

const FALLBACK_LINE = {
  pt: 'Estou aqui. Como posso ajudar?',
  en: "I'm here. How can I help?",
} as const;

export interface AskTalkerOptions {
  text: string;
  language?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * One short spoken sentence from the reflex model.
 * Never throws: a failed or slow talker returns a fixed line and reports
 * `fallback: true`, because a missing reply is worse than a plain one.
 */
export async function askTalker(options: AskTalkerOptions): Promise<TalkerResult> {
  const language = normalizeLanguage(options.language);
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = now();

  if (!apiKey) {
    return { text: FALLBACK_LINE[language], model: REFLEX_MODEL, talkerMs: now() - startedAt, fallback: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REFLEX_TIMEOUT_MS);
  try {
    const response = await fetchImpl(REFLEX_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: REFLEX_MODEL,
        messages: [
          { role: 'system', content: systemPrompt(language) },
          { role: 'user', content: options.text },
        ],
        max_tokens: 60,
        temperature: 0.6,
        // The whole 95ms lane depends on this: thinking must stay off.
        reasoning_effort: 'none',
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { text: FALLBACK_LINE[language], model: REFLEX_MODEL, talkerMs: now() - startedAt, fallback: true };
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = sanitizeReply(body.choices?.[0]?.message?.content || '');
    if (!text) {
      return { text: FALLBACK_LINE[language], model: REFLEX_MODEL, talkerMs: now() - startedAt, fallback: true };
    }
    return { text, model: REFLEX_MODEL, talkerMs: now() - startedAt, fallback: false };
  } catch {
    return { text: FALLBACK_LINE[language], model: REFLEX_MODEL, talkerMs: now() - startedAt, fallback: true };
  } finally {
    clearTimeout(timer);
  }
}
