/**
 * coexistirManagerRoutes.test.ts — the pinned tile's API over real HTTP.
 *
 * Contract the client depends on:
 *   GET /api/coexistir/manager/persona -> manager id/name/blurb
 *   GET /api/coexistir/manager/turn    -> { turn, tasks:[open…] }
 *
 * The store and the claim resolver are faked so this proves composition,
 * claim-name addressing and error handling without Mongo or the claims DB.
 */

import express from 'express';
import type { AddressInfo } from 'net';
import { createCoexistirManagerRouter } from '../coexistirManagerRoutes';
import type {
  CoexistirTaskView,
  TaskRepositoryLike,
} from '../../modules/coexistir/CoexistirTaskRepository';

const morning = new Date('2026-10-26T08:15:00');

function makeStore(rows: CoexistirTaskView[]) {
  const store: TaskRepositoryLike = {
    list: async () => rows.map((r) => ({ ...r })),
    create: async (data) => ({
      id: 'x',
      title: data.title,
      status: 'open',
      createdBy: data.createdBy,
      createdAt: morning.toISOString(),
    }),
    setStatus: async () => null,
    clear: async () => 0,
  };
  return store;
}

const tasks: CoexistirTaskView[] = [
  { id: '1', title: 'Buy coffee', status: 'open', createdAt: '2026-10-26T07:00:00.000Z' },
  { id: '2', title: 'Water plants', status: 'open', createdAt: '2026-10-26T07:05:00.000Z' },
  { id: '3', title: 'Pay the bill', status: 'done', createdAt: '2026-10-25T07:00:00.000Z' },
];

let server: ReturnType<express.application.listen>;
let baseUrl = '';

async function start(deps: Parameters<typeof createCoexistirManagerRouter>[0]) {
  const app = express();
  app.use('/api/coexistir/manager', createCoexistirManagerRouter(deps));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/coexistir/manager/persona', () => {
  it('returns the manager identity and blurb', async () => {
    await start({ taskRepo: makeStore(tasks), now: () => morning });
    const res = await fetch(`${baseUrl}/api/coexistir/manager/persona?language=en`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.managerId).toBe('coexistir-manager');
    expect(body.managerName).toBe('Mara');
    expect(body.blurb).toContain('house list');
    expect(body.intents).toEqual(['greeting', 'briefing', 'todos', 'reflection']);
  });
});

describe('GET /api/coexistir/manager/turn', () => {
  it('greets by CLAIM name (voice key wins over display name) and names real tasks', async () => {
    await start({
      taskRepo: makeStore(tasks),
      resolveMemberName: async (voiceKey, displayName) => ({
        name: voiceKey ? 'Rita (claimed)' : displayName,
      }),
      now: () => morning,
    });

    const res = await fetch(
      `${baseUrl}/api/coexistir/manager/turn?intent=greeting&voiceKey=owl:abc&displayName=Guest&seed=0&language=en`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.turn.text).toContain('Good morning, Rita (claimed).');
    expect(body.turn.namedTasks).toEqual(['Buy coffee', 'Water plants']);
    // Only open tasks are handed back for the tile's list.
    expect(body.tasks.map((t: CoexistirTaskView) => t.title)).toEqual(['Buy coffee', 'Water plants']);
    expect(body.turn.doneCount).toBe(1);
  });

  it('composes the todo review from the live list', async () => {
    await start({ taskRepo: makeStore(tasks), resolveMemberName: async () => ({}), now: () => morning });
    const res = await fetch(`${baseUrl}/api/coexistir/manager/turn?intent=todos`);
    const body = await res.json();
    expect(body.turn.intent).toBe('todos');
    expect(body.turn.text).toContain('Buy coffee and Water plants');
  });

  it('falls back to the greeting intent for unknown values and honours language=pt', async () => {
    await start({ taskRepo: makeStore(tasks), resolveMemberName: async () => ({}), now: () => morning });
    const res = await fetch(`${baseUrl}/api/coexistir/manager/turn?intent=bogus&language=pt-BR`);
    const body = await res.json();
    expect(body.turn.intent).toBe('greeting');
    expect(body.turn.language).toBe('pt');
    expect(body.turn.text.startsWith('Bom dia.')).toBe(true);
  });

  it('returns 500 with an error body when the store fails', async () => {
    const broken: TaskRepositoryLike = {
      list: async () => {
        throw new Error('mongo down');
      },
      create: async () => {
        throw new Error('mongo down');
      },
      setStatus: async () => null,
      clear: async () => 0,
    };
    await start({ taskRepo: broken, resolveMemberName: async () => ({}) });
    const res = await fetch(`${baseUrl}/api/coexistir/manager/turn?intent=briefing`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/manager turn/i);
  });
});
