/**
 * CoexistirTaskRepository.test.ts — slice-3 task row contract (pure parts).
 *
 * The Tasks tab depends on one shape: {id, title, status, createdBy, createdAt}.
 * Mongo access itself is exercised end-to-end against the live rig, so these
 * tests pin normalisation + serialisation without a database.
 */

import { normaliseTaskTitle, toTaskView } from '../CoexistirTaskRepository';

describe('normaliseTaskTitle', () => {
  it('trims and collapses whitespace', () => {
    expect(normaliseTaskTitle('  Buy   coffee \n today ')).toBe('Buy coffee today');
  });

  it('rejects empty, blank and non-string input', () => {
    expect(normaliseTaskTitle('')).toBeNull();
    expect(normaliseTaskTitle('   ')).toBeNull();
    expect(normaliseTaskTitle(undefined)).toBeNull();
    expect(normaliseTaskTitle(42)).toBeNull();
  });

  it('caps absurdly long titles at 200 chars', () => {
    const title = normaliseTaskTitle('a'.repeat(500));
    expect(title).toHaveLength(200);
  });
});

describe('toTaskView', () => {
  it('serialises a mongoose document to the client row shape', () => {
    const doc: any = {
      _id: { toString: () => 'task-1' },
      title: 'Buy coffee',
      status: 'open',
      createdBy: 'Rita',
      createdAt: new Date('2026-10-26T08:00:00.000Z'),
      doneAt: null,
    };

    expect(toTaskView(doc)).toEqual({
      id: 'task-1',
      title: 'Buy coffee',
      status: 'open',
      createdBy: 'Rita',
      createdAt: '2026-10-26T08:00:00.000Z',
      doneAt: undefined,
    });
  });

  it('keeps the completion timestamp for done tasks', () => {
    const doc: any = {
      _id: { toString: () => 'task-2' },
      title: 'Water the plants',
      status: 'done',
      createdAt: new Date('2026-10-26T07:00:00.000Z'),
      doneAt: new Date('2026-10-26T09:30:00.000Z'),
    };

    expect(toTaskView(doc).doneAt).toBe('2026-10-26T09:30:00.000Z');
  });
});
