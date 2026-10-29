/**
 * coexistirTaskRoutes.test.ts — the Tasks tab API, over real HTTP.
 *
 * Contract the client depends on:
 *   GET    /api/coexistir/tasks      -> { zoneId, tasks: [...] } (open + done)
 *   POST   /api/coexistir/tasks      -> 201 { task } (title required, claim name recorded)
 *   PATCH  /api/coexistir/tasks/:id  -> { task } checked off / re-opened
 *   DELETE /api/coexistir/tasks/:id  -> { ok: true }
 *
 * The store is faked so this proves routing/validation/attribution without
 * Mongo; persistence itself is verified on the live rig.
 */

import express from 'express';
import type { AddressInfo } from 'net';
import { createCoexistirTaskRouter } from '../coexistirTaskRoutes';
import type { CoexistirTaskView, TaskRepositoryLike } from '../../modules/coexistir/CoexistirTaskRepository';

function makeStore() {
  const rows: CoexistirTaskView[] = [];
  let seq = 0;
  const store: TaskRepositoryLike = {
    list: async () => rows.map((r) => ({ ...r })),
    create: async (data) => {
      const row: CoexistirTaskView = {
        id: `id-${++seq}`,
        title: data.title,
        status: 'open',
        createdBy: data.createdBy,
        createdAt: '2026-10-26T08:00:00.000Z',
      };
      rows.push(row);
      return { ...row };
    },
    setStatus: async (id, status) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = status;
      return { ...row };
    },
    remove: async (id) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) return false;
      rows.splice(idx, 1);
      return true;
    },
    clear: async () => {
      const n = rows.length;
      rows.length = 0;
      return n;
    },
  };
  return { store, rows };
}

let server: ReturnType<typeof express.application.listen>;
let baseUrl = '';

async function start(deps: Parameters<typeof createCoexistirTaskRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api/coexistir/tasks', createCoexistirTaskRouter(deps));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe('coexistir task routes', () => {
  it('lists open and done tasks scoped to the coexistir zone', async () => {
    const { store, rows } = makeStore();
    rows.push(
      { id: 'a', title: 'Buy coffee', status: 'open', createdAt: '2026-10-26T08:00:00.000Z' },
      { id: 'b', title: 'Water plants', status: 'done', createdAt: '2026-10-26T07:00:00.000Z' },
    );
    await start({ taskRepo: store });

    const res = await fetch(`${baseUrl}/api/coexistir/tasks`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.zoneId).toBe('coexistir');
    expect(body.tasks.map((t: CoexistirTaskView) => t.title)).toEqual(['Buy coffee', 'Water plants']);
  });

  it('adds a task and records the member claim name', async () => {
    const { store } = makeStore();
    await start({
      taskRepo: store,
      resolveMemberName: async () => ({ name: 'Rita (claim)' }),
    });

    const res = await fetch(`${baseUrl}/api/coexistir/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  Buy   coffee ', voiceKey: 'livekit:u:1' }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.task.title).toBe('Buy coffee');
    expect(body.task.status).toBe('open');
    expect(body.task.createdBy).toBe('Rita (claim)');
  });

  it('falls back to the display name when the member has no claim', async () => {
    const { store } = makeStore();
    await start({ taskRepo: store, resolveMemberName: async () => ({}) });

    const res = await fetch(`${baseUrl}/api/coexistir/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Call the plumber', displayName: 'Bruno' }),
    });
    const body = await res.json();
    expect(body.task.createdBy).toBe('Bruno');
  });

  it('rejects an empty title', async () => {
    const { store } = makeStore();
    await start({ taskRepo: store });

    const res = await fetch(`${baseUrl}/api/coexistir/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Task title is required');
  });

  it('checks a task off and re-opens it', async () => {
    const { store } = makeStore();
    await start({ taskRepo: store });

    const created = await (await fetch(`${baseUrl}/api/coexistir/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Buy coffee' }),
    })).json();

    const done = await fetch(`${baseUrl}/api/coexistir/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(done.status).toBe(200);
    expect((await done.json()).task.status).toBe('done');

    const reopened = await fetch(`${baseUrl}/api/coexistir/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' }),
    });
    expect((await reopened.json()).task.status).toBe('open');
  });

  it('rejects an unknown status and an unknown id', async () => {
    const { store } = makeStore();
    await start({ taskRepo: store });

    const bad = await fetch(`${baseUrl}/api/coexistir/tasks/abc`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'nope' }),
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(`${baseUrl}/api/coexistir/tasks/abc`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(missing.status).toBe(404);
  });

  it('deletes a task', async () => {
    const { store } = makeStore();
    await start({ taskRepo: store });

    const created = await (await fetch(`${baseUrl}/api/coexistir/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Temporary' }),
    })).json();

    const del = await fetch(`${baseUrl}/api/coexistir/tasks/${created.task.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const list = await (await fetch(`${baseUrl}/api/coexistir/tasks`)).json();
    expect(list.tasks).toHaveLength(0);
  });
});
