/**
 * nemotronTurn — the Nemotron polish lane for the front-door manager turn.
 *
 * Design (from the live probe, 2026-10-29, nvidia/nemotron-3-nano-30b-a3b):
 * - Ungrounded Nemotron FABRICATES house state (invented shop names/hours),
 *   the exact failure mode the reflex talker guards against. So Nemotron
 *   never answers from scratch: the route composes a deterministic briefing
 *   from real task rows (composeManagerTurn) and Nemotron only REPHRASES it
 *   into one warm spoken sentence, naming every task exactly as written.
 * - Grounded probe: "Bom dia! Ana, temos duas tarefas abertas para a casa:
 *   comprar café e regar as plantas." — both tasks named, nothing added.
 *   TTFT ~0.5-1.1s, total ~0.6-2.6s on hosted Nano 30B. That is NOT the
 *   95ms reflex lane (Groq qwen3.8-27b keeps that); it is the composed-turn
 *   lane, where ~1s is fine because the deterministic text can render first.
 *
 * Free-tier path (no card, no paid signup):
 *   1. Create + verify a free account at https://build.nvidia.com
 *      (top-right "Login" -> "Create an Account" joins the Developer Program).
 *   2. Open https://build.nvidia.com/settings -> "Generate API Key".
 *   3. Put it in the local .env as NEMOTRON_API_KEY (never commit .env).
 *   Free prototyping tier, OpenAI-compatible POST {base}/chat/completions,
 *   rate-limited (~40 RPM reported) — plenty for a front door.
 *
 * The key is runtime-only: NEMOTRON_API_KEY / NVIDIA_API_KEY come from the
 * process environment, never from a file in the repo, and are never logged.
 * With no key configured every function returns a deterministic fallback and
 * reports `fallback: true` — the door keeps working, panels say so honestly.
 */

import { normalizeLanguage, sanitizeReply } from './reflexTalker';

/** Smallest fast Nemotron on the NIM free tier; also served by mirrors. */
export const NEMOTRON_DEFAULT_MODEL = 'nvidia/nemotron-3-nano-30b-a3b';
/** NVIDIA-hosted free prototyping endpoint (OpenAI-compatible). */
export const NEMOTRON_DEFAULT_BASE = 'https://integrate.api.nvidia.com/v1';
/** Composed-turn lane budget: slower than reflex, still spoken-fast. */
export const NEMOTRON_TIMEOUT_MS = 8000;

export interface NemotronPolished {
  text: string;
  model: string;
  talkerMs: number;
  fallback: boolean;
}

export interface PolishBriefingOptions {
  /** Deterministic briefing from composeManagerTurn (real task rows). */
  briefing: string;
  language?: string;
  /** Task titles the reply MUST name (verified by the caller/tests). */
  mustName?: readonly string[];
  fetchImpl?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  now?: () => number;
  timeoutMs?: number;
}

export function nemotronEndpoint(): { baseUrl: string; model: string; configured: boolean } {
  const baseUrl = (process.env.NEMOTRON_API_BASE ?? NEMOTRON_DEFAULT_BASE).replace(/\/+$/, '');
  const model = process.env.NEMOTRON_MODEL ?? NEMOTRON_DEFAULT_MODEL;
  const configured = Boolean(process.env.NEMOTRON_API_KEY ?? process.env.NVIDIA_API_KEY);
  return { baseUrl, model, configured };
}

/** Grounding instruction: rephrase only, name every task, invent nothing. */
export function polishPrompt(briefing: string, language: 'pt' | 'en'): string {
  const lock =
    language === 'pt'
      ? 'Responda em português brasileiro.'
      : 'Reply in English.';
  return (
    'You are Mara, the front-door household assistant. Rephrase the briefing ' +
    'below into ONE warm spoken sentence a voice can read aloud. Name every ' +
    'task exactly as written. Do not add places, times, people, or advice ' +
    `that is not in the briefing. ${lock}\n\nBRIEFING: ${briefing}`
  );
}

/**
 * Polish one deterministic briefing through Nemotron. Never throws: without
 * a key, on timeout, or on a bad response it returns the briefing unchanged
 * with `fallback: true`, so the tile still speaks real task rows.
 */
export async function askNemotron(options: PolishBriefingOptions): Promise<NemotronPolished> {
  const language = normalizeLanguage(options.language);
  const { baseUrl, model } = nemotronEndpoint();
  const resolvedModel = options.model ?? model;
  const resolvedBase = (options.baseUrl ?? baseUrl).replace(/\/+$/, '');
  const apiKey = options.apiKey ?? process.env.NEMOTRON_API_KEY ?? process.env.NVIDIA_API_KEY;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = now();

  if (!apiKey) {
    return { text: options.briefing, model: resolvedModel, talkerMs: now() - startedAt, fallback: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? NEMOTRON_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${resolvedBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [{ role: 'user', content: polishPrompt(options.briefing, language) }],
        max_tokens: 120,
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { text: options.briefing, model: resolvedModel, talkerMs: now() - startedAt, fallback: true };
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = sanitizeReply(body.choices?.[0]?.message?.content || '');
    if (!text) {
      return { text: options.briefing, model: resolvedModel, talkerMs: now() - startedAt, fallback: true };
    }
    return { text, model: resolvedModel, talkerMs: now() - startedAt, fallback: false };
  } catch {
    return { text: options.briefing, model: resolvedModel, talkerMs: now() - startedAt, fallback: true };
  } finally {
    clearTimeout(timer);
  }
}
