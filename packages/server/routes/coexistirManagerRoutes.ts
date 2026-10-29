/**
 * coexistirManagerRoutes — the pinned front-door tile's text source.
 *
 *   GET /api/coexistir/manager/turn?intent=greeting&voiceKey=…&displayName=…&language=en
 *
 * Returns one composed turn (greeting / briefing / todos / reflection) built
 * from the SAME household task rows the Tasks tab writes, so the todo review
 * names the real tasks instead of a canned sample.
 *
 * Name resolution order is the claim rule from slice 2: the speaker's voice
 * key resolves to their community CLAIM name; the supplied display name is
 * only a fallback. The router is a factory so tests inject a fake store and
 * a fixed clock — no Mongo, no network.
 */

import express, { Request, Response } from 'express';
import {
  COEXISTIR_TASK_ZONE,
  CoexistirTaskRepository,
  TaskRepositoryLike,
} from '../modules/coexistir/CoexistirTaskRepository';
import { resolveClaimDisplayName } from '../modules/naming/claimDisplayName';
import {
  COEXISTIR_MANAGER_ID,
  COEXISTIR_MANAGER_NAME,
  composeManagerTurn,
  managerBlurb,
  normalizeManagerIntent,
  normalizeManagerLanguage,
} from '../modules/coexistir/managerPersona';

export interface CoexistirManagerRouterDeps {
  taskRepo?: TaskRepositoryLike;
  resolveMemberName?: (voiceKey?: string, displayName?: string) => Promise<{ name?: string }>;
  /** Injectable clock for tests (defaults to `new Date()`). */
  now?: () => Date;
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
        '[coexistirManagerRoutes] claim lookup failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  const fallback = (displayName ?? '').trim();
  return fallback ? { name: fallback } : {};
}

export function createCoexistirManagerRouter(
  deps: CoexistirManagerRouterDeps = {},
): express.Router {
  const router = express.Router();
  const taskRepo = deps.taskRepo ?? new CoexistirTaskRepository();
  const resolveMemberName = deps.resolveMemberName ?? defaultResolveMemberName;
  const now = deps.now ?? (() => new Date());

  /** Persona card: who is standing at the front door (no task data needed). */
  router.get('/persona', (req: Request, res: Response) => {
    const language = normalizeManagerLanguage(req.query.language);
    res.json({
      managerId: COEXISTIR_MANAGER_ID,
      managerName: COEXISTIR_MANAGER_NAME,
      language,
      blurb: managerBlurb(language),
      intents: ['greeting', 'briefing', 'todos', 'reflection'],
    });
  });

  router.get('/turn', async (req: Request, res: Response) => {
    const intent = normalizeManagerIntent(req.query.intent);
    const language = normalizeManagerLanguage(req.query.language);
    const voiceKey = typeof req.query.voiceKey === 'string' ? req.query.voiceKey : undefined;
    const displayName =
      typeof req.query.displayName === 'string' ? req.query.displayName : undefined;
    // Rotate the reflection question per member/day so it is not a stuck loop.
    const seed = Number.parseInt(String(req.query.seed ?? ''), 10);
    const today = now();

    try {
      const [tasks, member] = await Promise.all([
        taskRepo.list(COEXISTIR_TASK_ZONE),
        resolveMemberName(voiceKey, displayName),
      ]);
      const turn = composeManagerTurn({
        intent,
        memberName: member.name,
        tasks,
        language,
        now: today,
        seed: Number.isFinite(seed) ? seed : today.getDate(),
      });
      res.json({
        turn,
        tasks: tasks.filter((t) => t.status === 'open'),
      });
    } catch (err) {
      console.error('[coexistirManagerRoutes] turn failed:', err);
      res.status(500).json({ error: 'Could not compose the manager turn' });
    }
  });

  return router;
}

export default createCoexistirManagerRouter();
