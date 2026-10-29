/**
 * reflexTalker.test.ts — filler discipline.
 *
 * The shootout proved two things this module must encode:
 * - qwen3.8-27b answers smalltalk in ~95ms ONLY with `reasoning_effort=none`;
 * - it invents house state when asked (`a porta tá trancada?` -> "Sim, está
 *   trancada"), so state questions must never reach the model as answers.
 */

import {
  askTalker,
  classifyTurn,
  pickFiller,
  REFLEX_MODEL,
  sanitizeReply,
  systemPrompt,
} from '../reflexTalker';

describe('classifyTurn', () => {
  it.each([
    ['oi, tudo bem?', 'smalltalk'],
    ['bom dia!', 'smalltalk'],
    ['hey, are you there?', 'smalltalk'],
    ['thanks!', 'smalltalk'],
    ['quem é você?', 'smalltalk'],
    ['tudo bem com você', 'smalltalk'],
    ['ok', 'smalltalk'],
  ])('treats %p as smalltalk', (text, expected) => {
    expect(classifyTurn(text, 'pt').kind).toBe(expected);
  });

  it.each([
    ['o que tem na lista hoje?', 'house-list'],
    ['what tasks are still open for the house?', 'house-list'],
    ['quanto ficou a conta de luz?', 'open-question'],
    ['quem deixou a porta aberta?', 'house-list'],
    ['remind me to take out the trash', 'schedule'],
    ['should i pay the bill today?', 'planning'],
    ['a porta da frente está trancada?', 'open-question'],
  ])('treats %p as hard (%s)', (text, reason) => {
    const result = classifyTurn(text, 'pt');
    expect(result.kind).toBe('hard');
    expect(result.reason).toBe(reason);
    expect(result.flags.length).toBeGreaterThan(0);
  });

  it('keeps a greeting with a real question in the slow loop', () => {
    // The social pattern must not swallow the data request behind it.
    expect(classifyTurn('bom dia, o que tem na lista hoje?', 'pt').kind).toBe('hard');
  });
});

describe('fillers', () => {
  it('says what it is doing, in the speaker language', () => {
    expect(pickFiller('pt', 0)).toMatch(/conferir|olhar|ver/i);
    expect(pickFiller('en', 0)).toMatch(/check|look/i);
    expect(pickFiller('pt', 1)).not.toBe(pickFiller('pt', 0));
  });
});

describe('askTalker', () => {
  it('sends the 95ms lane config: model, no thinking, language lock', async () => {
    let seen: { url: string; body: Record<string, unknown>; auth?: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = {
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>).Authorization,
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Oi! Tudo bem, e com você?' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await askTalker({
      text: 'oi, tudo bem?',
      language: 'pt',
      fetchImpl,
      apiKey: 'test-key',
    });

    expect(result.text).toBe('Oi! Tudo bem, e com você?');
    expect(result.fallback).toBe(false);
    expect(seen!.url).toContain('api.groq.com/openai/v1/chat/completions');
    expect(seen!.body.model).toBe(REFLEX_MODEL);
    expect(seen!.body.reasoning_effort).toBe('none');
    expect(seen!.body.max_tokens).toBe(60);
    expect(seen!.auth).toBe('Bearer test-key');
    const messages = seen!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toMatch(/português/i);
  });

  it('locks English replies to English', () => {
    expect(systemPrompt('en')).toMatch(/Reply in English/);
    expect(systemPrompt('pt')).toMatch(/português/i);
  });

  it('falls back to a spoken line when the key is missing and never throws', async () => {
    const result = await askTalker({ text: 'hey', language: 'en', apiKey: '' });
    expect(result.fallback).toBe(true);
    expect(result.text).toBe("I'm here. How can I help?");
  });

  it('falls back on a provider error', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await askTalker({ text: 'hey', language: 'en', fetchImpl, apiKey: 'k' });
    expect(result.fallback).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('strips CJK drift from a reply', () => {
    expect(sanitizeReply('Bom dia! 你好 世界')).toBe('Bom dia!');
    expect(sanitizeReply('\u0000ok\u0007')).toBe('ok');
  });
});
