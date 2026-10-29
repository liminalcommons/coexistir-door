/**
 * Coexistir task routes — the household todo list behind the Tasks tab.
 *
 *   GET    /api/coexistir/tasks        list open + done
 *   POST   /api/coexistir/tasks        add {title, voiceKey?, displayName?}
 *   PATCH  /api/coexistir/tasks/:id    check off / re-open {status}
 *   DELETE /api/coexistir/tasks/:id    remove one (e2e hygiene)
 *
 * Persistence is server-side on purpose: the room is shared, so two members
 * must see the same list and a reload must never lose a task. Rows are scoped
 * to zone `coexistir`, the same zone the manager agent reads, so slice-3's
 * briefing/todo review can consume them.
 *
 * The router is a factory so tests can inject a fake store — no Mongo needed.
 */

import express, { Request, Response } from 'express';
import {
  COEXISTIR_TASK_ZONE,
  CoexistirTaskRepository,
  TaskRepositoryLike,
  normaliseTaskTitle,
} from '../modules/coexistir/CoexistirTaskRepository';
import { resolveClaimDisplayName } from '../modules/naming/claimDisplayName';

export interface CoexistirTaskRouterDeps {
  taskRepo?: TaskRepositoryLike;
  /** Resolve the speaker's claim name; falls back to the provided display name. */
  resolveMemberName?: (voiceKey?: string, displayName?: string) => Promise<{ name?: string }>;
}

async function defaultResolveMemberName(
  voiceKey?: string,
  displayName?: string,
): Promise<{ name?: string }> {
  if (voiceKey) {
    try {
      const claim = await resolveClaimDisplayName(voiceKey);
      if (claim?.name) return { name: claim.name };
    } catch (err) {
      console.warn(
        '[coexistirTaskRoutes] claim lookup failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  const fallback = (displayName ?? '').trim();
  return fallback ? { name: fallback } : {};
}

export function createCoexistirTaskRouter(deps: CoexistirTaskRouterDeps = {}): express.Router {
  const router = express.Router();
  const taskRepo = deps.taskRepo ?? new CoexistirTaskRepository();
  const resolveMemberName = deps.resolveMemberName ?? defaultResolveMemberName;

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const tasks = await taskRepo.list(COEXISTIR_TASK_ZONE);
      res.json({ zoneId: COEXISTIR_TASK_ZONE, tasks });
    } catch (err) {
      console.error('[coexistirTaskRoutes] list failed:', err);
      res.status(500).json({ error: 'Could not load tasks' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    const title = normaliseTaskTitle(req.body?.title);
    if (!title) {
      res.status(400).json({ error: 'Task title is required' });
      return;
    }
    try {
      const member = await resolveMemberName(req.body?.voiceKey, req.body?.displayName);
      const creator =
        member.name ?? (typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : undefined);
      const task = await taskRepo.create({
        title,
        createdBy: creator || undefined,
        createdByVoiceKey: req.body?.voiceKey,
        zoneId: COEXISTIR_TASK_ZONE,
      });
      res.status(201).json({ task });
    } catch (err) {
      console.error('[coexistirTaskRoutes] create failed:', err);
      res.status(500).json({ error: 'Could not save task' });
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const status = req.body?.status;
    if (status !== 'open' && status !== 'done') {
      res.status(400).json({ error: 'status must be "open" or "done"' });
      return;
    }
    try {
      const task = await taskRepo.setStatus(req.params.id, status, COEXISTIR_TASK_ZONE);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json({ task });
    } catch (err) {
      console.error('[coexistirTaskRoutes] update failed:', err);
      res.status(500).json({ error: 'Could not update task' });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    if (typeof taskRepo.remove !== 'function') {
      res.status(501).json({ error: 'Delete is not supported by this store' });
      return;
    }
    try {
      const removed = await taskRepo.remove(req.params.id, COEXISTIR_TASK_ZONE);
      if (!removed) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[coexistirTaskRoutes] delete failed:', err);
      res.status(500).json({ error: 'Could not delete task' });
    }
  });

  return router;
}

export default createCoexistirTaskRouter();
