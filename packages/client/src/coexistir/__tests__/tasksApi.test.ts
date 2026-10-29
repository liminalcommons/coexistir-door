/**
 * tasksApi.test.ts — wire contract for the Coexistir household task list.
 *
 * The Tasks tab must survive a reload and stay shared between members, so the
 * client only ever trusts what the server returns: these tests pin the fetch
 * shapes, the error surface, and the display ordering.
 */

import {
  addTask,
  countOpen,
  deleteTask,
  listTasks,
  orderTasks,
  pickMemberName,
  setTaskStatus,
  type CoexistirTask,
} from '../tasksApi';

const realFetch = global.fetch;

function mockJson(status: number, body: unknown) {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
});

describe('tasksApi', () => {
  it('lists tasks from /api/coexistir/tasks and normalises unknown statuses to open', async () => {
    global.fetch = mockJson(200, {
      zoneId: 'coexistir',
      tasks: [
        { id: '1', title: 'Buy coffee', status: 'open', createdBy: 'Rita' },
        { id: '2', title: 'Water plants', status: 'done' },
        { id: '3', title: 'Weird', status: 'blocked' },
      ],
    });

    const tasks = await listTasks();
    expect(global.fetch).toHaveBeenCalledWith('/api/coexistir/tasks');
    expect(tasks).toHaveLength(3);
    expect(tasks[1].status).toBe('done');
    expect(tasks[2].status).toBe('open');
    expect(tasks[0].createdBy).toBe('Rita');
  });

  it('throws a readable error when listing fails', async () => {
    global.fetch = mockJson(500, { error: 'Could not load tasks' });
    await expect(listTasks()).rejects.toThrow('Could not load tasks (500)');
  });

  it('posts a new task with the member display name', async () => {
    global.fetch = mockJson(201, {
      task: { id: '9', title: 'Call the plumber', status: 'open', createdBy: 'Bruno' },
    });

    const task = await addTask({ title: 'Call the plumber', displayName: 'Bruno' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];

    expect(url).toBe('/api/coexistir/tasks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      title: 'Call the plumber',
      displayName: 'Bruno',
      voiceKey: undefined,
    });
    expect(task.id).toBe('9');
    expect(task.createdBy).toBe('Bruno');
  });

  it('surfaces the server error text when adding fails', async () => {
    global.fetch = mockJson(400, { error: 'Task title is required' });
    await expect(addTask({ title: ' ' })).rejects.toThrow('Task title is required');
  });

  it('patches the status of one task', async () => {
    global.fetch = mockJson(200, {
      task: { id: '9', title: 'Call the plumber', status: 'done', doneAt: '2026-10-26T09:00:00.000Z' },
    });

    const task = await setTaskStatus('9', 'done');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];

    expect(url).toBe('/api/coexistir/tasks/9');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'done' });
    expect(task.status).toBe('done');
    expect(task.doneAt).toBe('2026-10-26T09:00:00.000Z');
  });

  it('encodes ids on delete', async () => {
    global.fetch = mockJson(200, { ok: true });
    await deleteTask('a/b');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/coexistir/tasks/a%2Fb');
  });

  it('orders open tasks first, oldest first, then done tasks', () => {
    const tasks: CoexistirTask[] = [
      { id: 'd1', title: 'done old', status: 'done', createdAt: '2026-10-26T06:00:00.000Z' },
      { id: 'o2', title: 'open new', status: 'open', createdAt: '2026-10-26T09:00:00.000Z' },
      { id: 'o1', title: 'open old', status: 'open', createdAt: '2026-10-26T07:00:00.000Z' },
    ];

    expect(orderTasks(tasks).map((t) => t.id)).toEqual(['o1', 'o2', 'd1']);
    expect(countOpen(tasks)).toBe(2);
  });

  it('picks the room name for new tasks and ignores the Unknown User placeholder', () => {
    expect(pickMemberName({ livekitName: 'Rita', userName: 'Rita Verifier', networkName: 'Unknown User' })).toBe('Rita');
    expect(pickMemberName({ livekitName: null, userName: 'Rita Verifier', networkName: 'Unknown User' })).toBe('Rita Verifier');
    expect(pickMemberName({ livekitName: '  ', userName: null, networkName: 'Unknown User' })).toBeUndefined();
    expect(pickMemberName({ livekitName: 'Guest', userName: 'Guest', networkName: 'guest' })).toBeUndefined();
  });
});
