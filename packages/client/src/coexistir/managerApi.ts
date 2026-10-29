/**
 * managerApi — the pinned agent tile's wire to the front door.
 *
 * Text-first: the server composes the turn (greeting / morning briefing /
 * todo review naming real tasks / reflection prompt) from the same household
 * list the Tasks tab writes. This module only moves strings, and hands them
 * to the voice controller through the existing `castalia:agent-reply` event
 * that slice-3b already listens for — so the tile never talks to TTS itself.
 */

import { AGENT_REPLY_EVENT } from './agentVoice';

export type ManagerIntent = 'greeting' | 'briefing' | 'todos' | 'reflection';
export type ManagerLanguage = 'en' | 'pt';

export interface ManagerTurn {
  managerId: string;
  managerName: string;
  intent: ManagerIntent;
  language: string;
  text: string;
  namedTasks: string[];
  openCount: number;
  doneCount: number;
}

export interface ManagerOpenTask {
  id: string;
  title: string;
  status: 'open' | 'done';
  createdBy?: string;
}

export interface ManagerTurnResult {
  turn: ManagerTurn;
  tasks: ManagerOpenTask[];
}

const API_BASE = '/api/coexistir/manager';

function qs(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.trim() !== '') search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

export async function fetchManagerTurn(args: {
  intent: ManagerIntent;
  voiceKey?: string;
  displayName?: string;
  language?: ManagerLanguage;
  seed?: number;
  fetchImpl?: typeof fetch;
}): Promise<ManagerTurnResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const url =
    `${API_BASE}/turn` +
    qs({
      intent: args.intent,
      voiceKey: args.voiceKey,
      displayName: args.displayName,
      language: args.language,
      seed: args.seed === undefined ? undefined : String(args.seed),
    });
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`Manager unavailable (${res.status})`);
  const body = (await res.json()) as Partial<ManagerTurnResult>;
  const turn = body.turn;
  if (!turn || typeof turn.text !== 'string' || turn.text.trim() === '') {
    throw new Error('Manager returned an empty turn');
  }
  return { turn, tasks: Array.isArray(body.tasks) ? body.tasks : [] };
}

export interface SpeakTarget {
  dispatchEvent: (event: Event) => boolean;
}

/** Fired alongside AGENT_REPLY_EVENT so visual surfaces can react to the turn itself. */
export const MANAGER_TURN_EVENT = 'castalia:manager-turn';

export interface ManagerTurnEventDetail {
  text: string;
  language: string;
  intent?: ManagerIntent;
  managerName?: string;
}

/**
 * Hand a composed turn to the voice layer. Autoplay policy and the room's
 * voice toggle stay the controller's business; this only announces the text.
 */
export function speakManagerTurn(
  turn: Pick<ManagerTurn, 'text' | 'language'> &
    Partial<Pick<ManagerTurn, 'intent' | 'managerName'>>,
  target: SpeakTarget | null = typeof window !== 'undefined' ? window : null,
): boolean {
  if (!target || !turn.text.trim()) return false;
  const event = new CustomEvent(AGENT_REPLY_EVENT, {
    detail: { text: turn.text, language: turn.language },
  });
  target.dispatchEvent(event);
  // The Live2D stage listens for this: same text, plus the intent keyword rules
  // use as a fallback when the sentence carries no strong emotion.
  target.dispatchEvent(
    new CustomEvent<ManagerTurnEventDetail>(MANAGER_TURN_EVENT, {
      detail: {
        text: turn.text,
        language: turn.language,
        intent: turn.intent,
        managerName: turn.managerName,
      },
    }),
  );
  return true;
}

/** The intent a member asked for by pressing a tile button. */
export const MANAGER_ACTIONS: ReadonlyArray<{
  intent: ManagerIntent;
  label: string;
  title: string;
}> = [
  { intent: 'briefing', label: 'Brief me', title: 'Morning briefing for the house' },
  { intent: 'todos', label: 'Todo review', title: 'Walk the open task list by name' },
  { intent: 'reflection', label: 'Reflect', title: 'One question to start the day' },
];
