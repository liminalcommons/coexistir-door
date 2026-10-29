/**
 * nemotronTurn.test.ts — the Nemotron polish lane without network or keys.
 *
 * Contract:
 * - without a key it returns the briefing unchanged with fallback=true
 *   (the door keeps speaking real task rows, panels say so honestly);
 * - with a key it POSTs an OpenAI-compatible chat request whose prompt
 *   carries the briefing and a no-invention grounding rule;
 * - a bad/empty model reply also falls back to the briefing, never throws.
 */

import { askNemotron, NEMOTRON_DEFAULT_MODEL, polishPrompt } from '../nemotronTurn';

const BRIEFING = 'Bom dia, Ana. 2 coisas ainda estão abertas para a casa: comprar café e regar as plantas.';

function fakeFetch(reply: string, ok = true) {
  return (async () => ({
    ok,
    json: async () => ({ choices: [{ message: { content: reply } }] }),
  })) as unknown as typeof fetch;
}

describe('polishPrompt', () => {
  it('carries the briefing and forbids inventing house state', () => {
    const prompt = polishPrompt(BRIEFING, 'pt');
    expect(prompt).toContain(BRIEFING);
    expect(prompt).toMatch(/do not add places|do not invent/i);
    expect(prompt).toMatch(/português brasileiro/i);
  });

  it('locks English when asked', () => {
    expect(polishPrompt(BRIEFING, 'en')).toMatch(/Reply in English/);
  });
});

describe('askNemotron', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('falls back to the briefing when no key is configured', async () => {
    delete process.env.NEMOTRON_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    const out = await askNemotron({ briefing: BRIEFING, language: 'pt' });
    expect(out.text).toBe(BRIEFING);
    expect(out.fallback).toBe(true);
    expect(out.model).toBe(NEMOTRON_DEFAULT_MODEL);
  });

  it('polishes through the model and reports the lane latency', async () => {
    const out = await askNemotron({
      briefing: BRIEFING,
      language: 'pt',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      fetchImpl: fakeFetch('Bom dia, Ana! Comprar café e regar as plantas seguem abertos.'),
    });
    expect(out.fallback).toBe(false);
    expect(out.text).toContain('comprar café');
    expect(out.talkerMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the briefing on an empty model reply', async () => {
    const out = await askNemotron({
      briefing: BRIEFING,
      language: 'pt',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      fetchImpl: fakeFetch('   '),
    });
    expect(out.text).toBe(BRIEFING);
    expect(out.fallback).toBe(true);
  });

  it('falls back to the briefing on HTTP errors without throwing', async () => {
    const out = await askNemotron({
      briefing: BRIEFING,
      language: 'en',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      fetchImpl: fakeFetch('nope', false),
    });
    expect(out.text).toBe(BRIEFING);
    expect(out.fallback).toBe(true);
  });
});
