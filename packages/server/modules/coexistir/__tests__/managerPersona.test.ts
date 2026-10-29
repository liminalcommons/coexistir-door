/**
 * managerPersona.test.ts — the front door's copy, pinned.
 *
 * The manager is only useful if it (a) uses the member's CLAIM name, (b) names
 * the ACTUAL open tasks instead of a count, and (c) offers a reflection
 * question. These tests hold those three promises in both languages.
 */

import {
  COEXISTIR_MANAGER_ID,
  COEXISTIR_MANAGER_NAME,
  DEFAULT_MANAGER_LANGUAGE,
  composeManagerTurn,
  managerBlurb,
  normalizeManagerIntent,
  normalizeManagerLanguage,
} from '../managerPersona';
import type { CoexistirTaskView } from '../CoexistirTaskRepository';

const morning = new Date('2026-10-26T08:30:00');

function task(title: string, status: 'open' | 'done' = 'open'): CoexistirTaskView {
  return {
    id: title.toLowerCase().replace(/\s+/g, '-'),
    title,
    status,
    createdAt: '2026-10-26T07:00:00.000Z',
  };
}

describe('composeManagerTurn — greeting', () => {
  it('addresses the member by claim name and names the open tasks', () => {
    const turn = composeManagerTurn({
      intent: 'greeting',
      language: 'en',
      memberName: 'Rita',
      tasks: [task('Buy coffee'), task('Water plants'), task('Call the landlord', 'done')],
      now: morning,
      seed: 0,
    });

    expect(turn.managerId).toBe(COEXISTIR_MANAGER_ID);
    expect(turn.managerName).toBe(COEXISTIR_MANAGER_NAME);
    expect(turn.text.startsWith('Good morning, Rita.')).toBe(true);
    expect(turn.text).toContain('Water plants');
    expect(turn.text).toContain('Buy coffee');
    // Done tasks are counted, not named as to-dos.
    expect(turn.namedTasks).toEqual(['Buy coffee', 'Water plants']);
    expect(turn.openCount).toBe(2);
    expect(turn.doneCount).toBe(1);
  });

  it('falls back to a nameless greeting when there is no claim name', () => {
    const turn = composeManagerTurn({
      intent: 'greeting',
      language: 'en',
      tasks: [],
      now: morning,
      seed: 1,
    });

    expect(turn.text.startsWith('Good morning.')).toBe(true);
    expect(turn.text).not.toContain('undefined');
    expect(turn.text).toContain('Nothing is open for the house');
    expect(turn.namedTasks).toEqual([]);
  });

  it('rotates the reflection question by seed', () => {
    const first = composeManagerTurn({ intent: 'greeting', tasks: [], seed: 0, now: morning, language: 'en' });
    const second = composeManagerTurn({ intent: 'greeting', tasks: [], seed: 1, now: morning, language: 'en' });
    expect(first.text).not.toBe(second.text);
  });
});

describe('composeManagerTurn — morning briefing', () => {
  it('greets, then the day at a glance, then the first tasks by name', () => {
    const turn = composeManagerTurn({
      intent: 'briefing',
      language: 'en',
      memberName: 'Ana',
      tasks: [task('Buy coffee'), task('Fix the sink'), task('Pay the bill'), task('Sweep')],
      now: morning,
    });

    expect(turn.text.startsWith('Good morning, Ana.')).toBe(true);
    expect(turn.text).toContain('4 things are still open for the house:');
    expect(turn.text).toContain('Buy coffee, Fix the sink, and Pay the bill.');
    // Briefing names at most three so it stays speakable.
    expect(turn.namedTasks).toEqual(['Buy coffee', 'Fix the sink', 'Pay the bill']);
    expect(turn.openCount).toBe(4);
  });

  it('says the day is free when nothing is open', () => {
    const turn = composeManagerTurn({
      intent: 'briefing',
      language: 'en',
      memberName: 'Ana',
      tasks: [task('Sweep', 'done')],
      now: new Date('2026-10-26T19:00:00'),
    });
    expect(turn.text.startsWith('Good evening, Ana.')).toBe(true);
    expect(turn.text).toContain('Nothing is open for the house right now');
    expect(turn.text).toContain('One task is done.');
  });
});

describe('composeManagerTurn — todo review', () => {
  it('names every open task in insertion order', () => {
    const turn = composeManagerTurn({
      intent: 'todos',
      language: 'en',
      memberName: 'Rita',
      tasks: [task('Buy coffee'), task('Water plants'), task('Call mum', 'done')],
      now: morning,
    });

    expect(turn.namedTasks).toEqual(['Buy coffee', 'Water plants']);
    expect(turn.text).toContain("Rita, here's where the house stands");
    expect(turn.text).toContain('Buy coffee and Water plants');
    expect(turn.text).toContain('One task is done.');
  });

  it('asks for the first task when the list is empty', () => {
    const turn = composeManagerTurn({ intent: 'todos', memberName: 'Rita', tasks: [], now: morning, language: 'en' });
    expect(turn.text).toContain('The todo list is empty');
    expect(turn.namedTasks).toEqual([]);
  });
});

describe('composeManagerTurn — reflection', () => {
  it('offers one question, prefixed with the claim name', () => {
    const turn = composeManagerTurn({
      intent: 'reflection',
      language: 'en',
      memberName: 'Rita',
      tasks: [],
      seed: 2,
      now: morning,
    });
    expect(turn.text.startsWith('Rita, one question before we begin:')).toBe(true);
    expect(turn.text.length).toBeGreaterThan(30);
  });
});

describe('language', () => {
  it('composes PT-BR copy for a PT household member', () => {
    const turn = composeManagerTurn({
      intent: 'briefing',
      memberName: 'Ana',
      tasks: [task('Comprar café')],
      language: 'pt',
      now: morning,
    });
    expect(turn.language).toBe('pt');
    expect(turn.text.startsWith('Bom dia, Ana.')).toBe(true);
    expect(turn.text).toContain('Comprar café');
    expect(turn.text).toContain('Uma coisa ainda está aberta');
  });

  it('normalizes language and intent inputs instead of throwing', () => {
    expect(normalizeManagerLanguage('pt-BR')).toBe('pt');
    expect(normalizeManagerLanguage('en-US')).toBe('en');
    expect(normalizeManagerLanguage('nonsense')).toBe('en');
    expect(normalizeManagerIntent('TODOS')).toBe('todos');
    expect(normalizeManagerIntent('nonsense')).toBe('greeting');
    expect(managerBlurb('pt')).toContain('lista da casa');
  });

  it('defaults to PT so the locked Flux Mariana voice speaks the default turn', () => {
    // The TTS resolver routes language 'en' to the English fallback voice;
    // an EN default therefore made the room sound like the placeholder
    // instead of Mariana. The default turn must stay on Mariana's language.
    expect(DEFAULT_MANAGER_LANGUAGE).toBe('pt');
    expect(normalizeManagerLanguage(undefined)).toBe('pt');
    expect(normalizeManagerLanguage('')).toBe('pt');
    const turn = composeManagerTurn({
      intent: 'greeting',
      memberName: 'Ana',
      tasks: [],
      language: normalizeManagerLanguage(undefined),
      now: morning,
    });
    expect(turn.language).toBe('pt');
    expect(turn.text).toContain('Bom dia, Ana.');
  });

  it('joins PT task titles with "e", never the English "and" (the greeting bug)', () => {
    // The door used to say "…comprar café e pão and regar as plantas…": the
    // joiner was hard-coded English while the sentence was Portuguese. This is
    // the greeting path, where exactly two tasks are named.
    const turn = composeManagerTurn({
      intent: 'greeting',
      memberName: 'Rita',
      tasks: [task('comprar café e pão'), task('regar as plantas da varanda')],
      language: 'pt',
      now: morning,
    });
    expect(turn.text).toContain('comprar café e pão e regar as plantas da varanda.');
    expect(turn.text).not.toContain(' and ');
  });

  it('joins three PT titles with a comma and a final "e" (no Oxford comma)', () => {
    const turn = composeManagerTurn({
      intent: 'todos',
      memberName: 'Rita',
      tasks: [task('comprar pão'), task('regar as plantas'), task('pagar a luz')],
      language: 'pt',
      now: morning,
    });
    expect(turn.text).toContain('comprar pão, regar as plantas e pagar a luz.');
    expect(turn.text).not.toContain(', and ');
    expect(turn.text).not.toContain(' and ');
  });

  it('keeps the English joiner when the turn is English', () => {
    const two = composeManagerTurn({
      intent: 'greeting',
      tasks: [task('Buy coffee'), task('Water plants')],
      language: 'en',
      now: morning,
    });
    expect(two.text).toContain('Buy coffee and Water plants');
    const three = composeManagerTurn({
      intent: 'todos',
      tasks: [task('Buy coffee'), task('Water plants'), task('Pay the bill')],
      language: 'en',
      now: morning,
    });
    expect(three.text).toContain('Buy coffee, Water plants, and Pay the bill');
  });
});
