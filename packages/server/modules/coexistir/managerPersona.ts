/**
 * coexistirManagerPersona — the front door's voice in text.
 *
 * The Coexistir manager is the thing you meet when you walk in: it greets you
 * by your CLAIM name (never the tile name — twin-merge misattributes those),
 * gives the morning briefing, reviews the household todo list by naming the
 * actual tasks, and asks a reflection question.
 *
 * Text-first on purpose: the tile renders these lines, and the client feeds
 * the same string to the TTS profile (`coexistir-manager` / Flux Mariana).
 * Everything here is a pure function of its inputs so the copy is testable
 * and the route never needs Mongo or an LLM to answer.
 *
 * The household is bilingual (EN / PT-BR), so every fixed phrase exists in
 * both languages; task titles pass through untranslated (they are the
 * member's own words).
 */

import type { CoexistirTaskView } from './CoexistirTaskRepository';

/** Agent id shared with the TTS profile and the client (`COEXISTIR_AGENT_ID`). */
export const COEXISTIR_MANAGER_ID = 'coexistir-manager';

/** What the pinned tile calls itself. */
export const COEXISTIR_MANAGER_NAME = 'Mara';

export type ManagerIntent = 'greeting' | 'briefing' | 'todos' | 'reflection';

export const MANAGER_INTENTS: readonly ManagerIntent[] = [
  'greeting',
  'briefing',
  'todos',
  'reflection',
];

export type ManagerLanguage = 'en' | 'pt';

/**
 * Language a turn is composed in when the caller does not ask for one.
 *
 * The room's locked voice is Flux Mariana (`flux-mariana-pt`, pt-BR), so the
 * composed text must default to Portuguese — an English-by-default text is
 * what routed the manager to the English placeholder voice and made the room
 * stop sounding like Mariana. English stays available as an explicit request
 * (`?language=en`) and resolves to the EN fallback voice.
 */
export const DEFAULT_MANAGER_LANGUAGE: ManagerLanguage = 'pt';

export function normalizeManagerLanguage(raw: unknown): ManagerLanguage {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return DEFAULT_MANAGER_LANGUAGE;
  return value.startsWith('pt') ? 'pt' : 'en';
}

export function normalizeManagerIntent(raw: unknown): ManagerIntent {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (MANAGER_INTENTS as readonly string[]).includes(value)
    ? (value as ManagerIntent)
    : 'greeting';
}

/** Fixed phrases, both languages. Keep them short — they are spoken aloud. */
const LINES = {
  en: {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    welcome: "Welcome back to Coexistir. I'm Mara, at the front door.",
    openOne: 'One thing is still open for the house:',
    openMany: (n: number) => `${n} things are still open for the house:`,
    nothingOpen: 'Nothing is open for the house right now — the day is yours.',
    doneSummary: (n: number) => (n === 1 ? 'One task is done.' : `${n} tasks are done.`),
    todosIntro: "Here's where the house stands:",
    todosEmpty:
      "The todo list is empty. Tell me one thing the house needs today and I'll keep it.",
    reflect: [
      'What would make today feel well spent?',
      'What is one thing you want to let go of before you start?',
      'Who in the house could use a hand today?',
      'What are you carrying that you could put down for an hour?',
    ],
    reflectLead: 'One question before we begin:',
    intro: 'I keep the house list, the briefing, and the quiet questions.',
  },
  pt: {
    morning: 'Bom dia',
    afternoon: 'Boa tarde',
    evening: 'Boa noite',
    welcome: 'Bem-vindo de volta à Coexistir. Sou a Mara, na porta de entrada.',
    openOne: 'Uma coisa ainda está aberta para a casa:',
    openMany: (n: number) => `${n} coisas ainda estão abertas para a casa:`,
    nothingOpen: 'Nada está aberto para a casa agora — o dia é seu.',
    doneSummary: (n: number) => (n === 1 ? 'Uma tarefa está concluída.' : `${n} tarefas estão concluídas.`),
    todosIntro: 'É assim que a casa está:',
    todosEmpty:
      'A lista está vazia. Diga uma coisa que a casa precisa hoje e eu guardo.',
    reflect: [
      'O que faria o dia de hoje valer a pena?',
      'O que você quer deixar ir antes de começar?',
      'Quem na casa poderia usar uma ajuda hoje?',
      'O que você está carregando que poderia descansar por uma hora?',
    ],
    reflectLead: 'Uma pergunta antes de começarmos:',
    intro: 'Eu guardo a lista da casa, o resumo do dia e as perguntas quietas.',
  },
} as const;

function greetingFor(hour: number, lang: ManagerLanguage): string {
  const table = LINES[lang];
  if (hour < 12) return table.morning;
  if (hour < 18) return table.afternoon;
  return table.evening;
}

/** `Good morning, Ana.` — the claim name is the whole point of the greeting. */
function address(name: string, lang: ManagerLanguage, hour: number): string {
  const timeOfDay = greetingFor(hour, lang);
  return name ? `${timeOfDay}, ${name}.` : `${timeOfDay}.`;
}

export interface ManagerTurnInput {
  intent: ManagerIntent;
  /** Member's CLAIM name (resolveClaimDisplayName), not the LiveKit tile name. */
  memberName?: string;
  /** All household tasks for zone `coexistir` (open + done). */
  tasks: readonly CoexistirTaskView[];
  language?: ManagerLanguage;
  /** Injectable clock — the briefing is time-of-day aware. */
  now?: Date;
  /** Rotates the reflection question so it is not the same every visit. */
  seed?: number;
}

export interface ManagerTurn {
  managerId: string;
  managerName: string;
  intent: ManagerIntent;
  language: ManagerLanguage;
  /** One string, ready for both the tile and TTS. */
  text: string;
  /** The task titles the reply actually named (empty when none were open). */
  namedTasks: string[];
  openCount: number;
  doneCount: number;
}

function openTitles(tasks: readonly CoexistirTaskView[]): string[] {
  return tasks.filter((t) => t.status === 'open').map((t) => t.title);
}

function listPhrase(titles: readonly string[], language: ManagerLanguage): string {
  if (titles.length <= 1) return titles[0] ?? '';
  // The joiner is COPY, so it follows the turn's language. This function used
  // to hard-code the English "and" for every language, which is why a PT
  // greeting read "…comprar café e pão and regar as plantas…". The PT list
  // uses a bare "e" (no Oxford comma); EN keeps its ", and".
  if (titles.length === 2) {
    return language === 'pt' ? `${titles[0]} e ${titles[1]}` : `${titles[0]} and ${titles[1]}`;
  }
  const head = titles.slice(0, -1).join(', ');
  const last = titles[titles.length - 1];
  return language === 'pt' ? `${head} e ${last}` : `${head}, and ${last}`;
}

/**
 * Compose one manager turn. Deterministic apart from the clock and `seed`,
 * so the route can be tested with a fixed date and every intent is provable.
 */
export function composeManagerTurn(input: ManagerTurnInput): ManagerTurn {
  // Default to the door's locked language (PT / Flux Mariana), not English:
  // `DEFAULT_MANAGER_LANGUAGE` is the contract, and a caller that omits the
  // language must not silently compose English copy under a Portuguese voice.
  const language: ManagerLanguage = input.language ?? DEFAULT_MANAGER_LANGUAGE;
  const table = LINES[language];
  const name = (input.memberName ?? '').trim();
  const tasks = input.tasks ?? [];
  const opens = openTitles(tasks);
  const doneCount = tasks.length - opens.length;
  const now = input.now ?? new Date();
  const hour = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getHours() : 9;

  let text: string;
  let namedTasks: string[] = [];

  switch (input.intent) {
    case 'briefing': {
      // Morning briefing: greeting by claim name, then the day at a glance,
      // then the first tasks by name. Never a bare count.
      const greet = name
        ? `${hour < 12 ? table.morning : hour < 18 ? table.afternoon : table.evening}, ${name}.`
        : `${hour < 12 ? table.morning : hour < 18 ? table.afternoon : table.evening}.`;
      const parts: string[] = [greet];
      if (opens.length === 0) {
        parts.push(table.nothingOpen);
      } else {
        namedTasks = opens.slice(0, 3);
        parts.push(opens.length === 1 ? table.openOne : table.openMany(opens.length));
        parts.push(listPhrase(namedTasks, language) + '.');
      }
      if (doneCount > 0) parts.push(table.doneSummary(doneCount));
      text = parts.join(' ');
      break;
    }

    case 'todos': {
      if (opens.length === 0) {
        text = [name ? `${table.morning}, ${name}.` : `${table.morning}.`, table.todosEmpty].join(' ');
        break;
      }
      namedTasks = opens;
      const lines = [`${table.todosIntro} ${listPhrase(opens, language)}.`];
      if (doneCount > 0) lines.push(table.doneSummary(doneCount));
      const body = lines.join(' ');
      // The intro runs mid-sentence after the member's name, so it keeps its
      // lowercase opening there and only capitalizes when it leads.
      text = name
        ? `${name}, ${body.charAt(0).toLowerCase()}${body.slice(1)}`
        : `${body.charAt(0).toUpperCase()}${body.slice(1)}`;
      break;
    }

    case 'reflection': {
      const prompts = table.reflect;
      const index = Math.abs(Math.trunc(input.seed ?? 0)) % prompts.length;
      const lead = name ? `${name}, ${table.reflectLead.toLowerCase()}` : table.reflectLead;
      text = `${lead} ${prompts[index]}`;
      break;
    }

    case 'greeting':
    default: {
      // Front door: who I am, what is waiting, one question. Short.
      const parts = [address(name, language, hour)];
      parts.push(table.welcome);
      if (opens.length > 0) {
        namedTasks = opens.slice(0, 2);
        parts.push(opens.length === 1 ? table.openOne : table.openMany(opens.length));
        parts.push(listPhrase(namedTasks, language) + '.');
      } else {
        parts.push(table.nothingOpen);
      }
      const prompts = table.reflect;
      parts.push(prompts[Math.abs(Math.trunc(input.seed ?? 0)) % prompts.length]);
      text = parts.join(' ');
      break;
    }
  }

  return {
    managerId: COEXISTIR_MANAGER_ID,
    managerName: COEXISTIR_MANAGER_NAME,
    intent: input.intent,
    language,
    text: text.replace(/\s+/g, ' ').trim(),
    namedTasks,
    openCount: opens.length,
    doneCount,
  };
}

/** Static persona blurb the tile shows under the manager's name. */
export function managerBlurb(language: ManagerLanguage = 'en'): string {
  return LINES[language].intro;
}
