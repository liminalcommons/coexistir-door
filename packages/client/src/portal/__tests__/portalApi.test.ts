/**
 * portalApi.test.ts — the ear's client half, without a browser.
 *
 * Two contracts that the portal depends on:
 *  - a spoken question picks the same manager intent the TALK button used to
 *    supply (and `undefined` when it does not clearly match, so the bridge
 *    keeps its own classification);
 *  - the recorded Blob is posted as a RAW body with the recorder's own MIME
 *    type, and a provider failure comes back typed instead of thrown.
 */

import { inferVoiceIntent, transcribeUtterance } from '../portalApi';

describe('inferVoiceIntent', () => {
  it.each([
    ['Mara, me dá o briefing da casa hoje?', 'briefing'],
    ['o que tem na lista hoje?', 'todos'],
    ['quais são as tarefas abertas?', 'todos'],
    ['o que eu deveria pensar hoje?', 'reflection'],
    ['Mara, what is on the list today?', 'todos'],
    ['give me the briefing', 'briefing'],
  ])('maps %p -> %p', (text, expected) => {
    expect(inferVoiceIntent(text)).toBe(expected);
  });

  it('refuses to guess on a question it does not recognise', () => {
    expect(inferVoiceIntent('oi, tudo bem?')).toBeUndefined();
    expect(inferVoiceIntent('quem é você')).toBeUndefined();
    expect(inferVoiceIntent('')).toBeUndefined();
  });
});

describe('transcribeUtterance', () => {
  const okBody = {
    ok: true,
    provider: 'deepgram',
    model: 'nova-3',
    text: 'me dá o briefing da casa hoje',
    language: 'pt',
    detectedLanguage: 'pt',
    languageConfidence: 0.99,
    confidence: 0.98,
    durationSec: 3.2,
    bytes: 4096,
    mimetype: 'audio/webm',
    sttMs: 240,
    providerMs: 230,
  };

  // jsdom in this repo has neither `globalThis.fetch` nor `Response`, so both
  // are installed by hand rather than spied on.
  const originalFetch = globalThis.fetch;
  const fakeResponse = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    }) as unknown as Response;
  const stubFetch = (impl: () => Promise<Response>) => {
    const mock = jest.fn(impl);
    (globalThis as { fetch?: unknown }).fetch = mock;
    return mock;
  };

  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  it('posts the clip as a raw audio body and returns the transcript', async () => {
    const fetchMock = stubFetch(async () => fakeResponse(200, okBody));
    const blob = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' });

    const result = await transcribeUtterance(blob, { language: 'auto' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/coexistir/voice/stt?');
    expect(url).toContain('language=auto');
    expect(url).toContain('room=coexistir');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/webm;codecs=opus');
    expect(init.body).toBe(blob);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('me dá o briefing da casa hoje');
    expect(result.language).toBe('pt');
    expect(result.sttMs).toBe(240);
  });

  it('surfaces a typed provider failure instead of throwing', async () => {
    stubFetch(async () =>
      fakeResponse(502, { ...okBody, ok: false, text: '', language: null, reason: 'http', sttMs: 90 }),
    );
    const result = await transcribeUtterance(new Blob([new Uint8Array(8)], { type: 'audio/webm' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('http');
    expect(result.text).toBe('');
  });

  it('throws when the server answers without a JSON body at all', async () => {
    stubFetch(async () =>
      ({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }) as unknown as Response,
    );
    await expect(
      transcribeUtterance(new Blob([new Uint8Array(8)], { type: 'audio/webm' })),
    ).rejects.toThrow('502');
  });
});
