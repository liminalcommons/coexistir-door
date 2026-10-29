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
import {
  askNemotron,
  nemotronEndpoint,
  type NemotronPolished,
} from '../modules/coexistir/nemotronTurn';

export interface CoexistirManagerRouterDeps {
  taskRepo?: TaskRepositoryLike;
  resolveMemberName?: (voiceKey?: string, displayName?: string) => Promise<{ name?: string }>;
  /** Injectable clock for tests (defaults to `new Date()`). */
  now?: () => Date;
  /** Injectable Nemotron polish lane (defaults to askNemotron — env key). */
  polishTurn?: (briefing: string, language: 'en' | 'pt') => Promise<NemotronPolished>;
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
  const polishTurn =
    deps.polishTurn ??
    ((briefing: string, language: 'en' | 'pt') => askNemotron({ briefing, language }));

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
    // Model option: `local` (default, deterministic compose) or `nemotron`
    // (deterministic compose, then the Nemotron polish lane rephrases it).
    const model = typeof req.query.model === 'string' ? req.query.model.trim().toLowerCase() : 'local';
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
      if (model !== 'nemotron') {
        res.json({
          turn,
          tasks: tasks.filter((t) => t.status === 'open'),
        });
        return;
      }
      // Nemotron lane: the composed text is the ground truth; the model only
      // rephrases it (ungrounded Nemotron fabricates house state — see
      // nemotronTurn.ts). Without a key this returns the briefing unchanged
      // with provider.fallback=true, so the tile still speaks real rows.
      const polished = await polishTurn(turn.text, language);
      res.json({
        turn: { ...turn, text: polished.text },
        tasks: tasks.filter((t) => t.status === 'open'),
        provider: {
          model: polished.model,
          talkerMs: polished.talkerMs,
          fallback: polished.fallback,
        },
      });
    } catch (err) {
      console.error('[coexistirManagerRoutes] turn failed:', err);
      res.status(500).json({ error: 'Could not compose the manager turn' });
    }
  });

  /**
   * Free-tier probe: is a Nemotron key configured? Reports the endpoint and
   * model only — the key itself never leaves the process environment.
   */
  router.get('/nemotron', (_req: Request, res: Response) => {
    const endpoint = nemotronEndpoint();
    res.json({
      provider: 'nemotron',
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      configured: endpoint.configured,
      hint: endpoint.configured
        ? 'Ready — GET /turn?model=nemotron polishes the composed turn.'
        : 'Set NEMOTRON_API_KEY (free key at https://build.nvidia.com/settings) in local .env.',
    });
  });

  return router;
}

export default createCoexistirManagerRouter();
