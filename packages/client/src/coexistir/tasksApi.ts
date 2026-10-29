/**
 * tasksApi — thin fetch client for the Coexistir household task list.
 *
 * Slice-3 stores tasks server-side (zone `coexistir`) so every member of the
 * room sees the same list and a reload never loses one. This module owns the
 * wire shape only; ordering/grouping for the UI lives in the component.
 */

export type CoexistirTaskStatus = 'open' | 'done';

export interface CoexistirTask {
  id: string;
  title: string;
  status: CoexistirTaskStatus;
  createdBy?: string;
  createdAt?: string;
  doneAt?: string;
}

const API_BASE = '/api/coexistir/tasks';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _raw: text };
  }
}

function toTask(raw: any): CoexistirTask {
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    status: raw?.status === 'done' ? 'done' : 'open',
    createdBy: raw?.createdBy ?? undefined,
    createdAt: raw?.createdAt ?? undefined,
    doneAt: raw?.doneAt ?? undefined,
  };
}

export async function listTasks(): Promise<CoexistirTask[]> {
  const res = await fetch(API_BASE);
  if (!res.ok) throw new Error(`Could not load tasks (${res.status})`);
  const body = await readJson(res);
  return Array.isArray(body.tasks) ? body.tasks.map(toTask) : [];
}

export async function addTask(args: {
  title: string;
  displayName?: string;
  voiceKey?: string;
}): Promise<CoexistirTask> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: args.title,
      displayName: args.displayName,
      voiceKey: args.voiceKey,
    }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(body?.error || `Could not add task (${res.status})`);
  return toTask(body.task);
}

export async function setTaskStatus(id: string, status: CoexistirTaskStatus): Promise<CoexistirTask> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(body?.error || `Could not update task (${res.status})`);
  return toTask(body.task);
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Could not delete task (${res.status})`);
}

/** Open tasks first (oldest first), done tasks after, so the list reads as a day. */
export function orderTasks(tasks: CoexistirTask[]): CoexistirTask[] {
  const rank = (t: CoexistirTask) => (t.status === 'done' ? 1 : 0);
  return [...tasks].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });
}

export function countOpen(tasks: CoexistirTask[]): number {
  return tasks.filter((t) => t.status === 'open').length;
}

/**
 * The member name to stamp on a new task.
 *
 * Prefer the LiveKit participant name (what the room shows), then the signed-in
 * user's name, then the network store — never the "Unknown User" placeholder,
 * which is what makes a task look like it came from nobody.
 */
export function pickMemberName(sources: {
  livekitName?: string | null;
  userName?: string | null;
  networkName?: string | null;
}): string | undefined {
  const clean = (v?: string | null) => {
    const s = (v ?? '').trim();
    if (!s || s.toLowerCase() === 'unknown user' || s.toLowerCase() === 'guest') return undefined;
    return s;
  };
  return clean(sources.livekitName) ?? clean(sources.userName) ?? clean(sources.networkName);
}
