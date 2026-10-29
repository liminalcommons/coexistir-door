/**
 * deepgramStt.test.ts — the ear's contract without the network.
 *
 * The provider is faked at `fetch`, so these assertions are about what we SEND
 * (model, detect-vs-pinned language, container), what we READ back (transcript,
 * detected language, confidence, duration) and how every failure is typed
 * instead of thrown.
 */

import {
  DEFAULT_STT_MODEL,
  buildListenQuery,
  parseListenResponse,
  silentWav,
  toTurnLanguage,
  transcribeAudio,
} from '../deepgramStt';

const OK_BODY = {
  metadata: { duration: 3.264 },
  results: {
    channels: [
      {
        detected_language: 'pt',
        language_confidence: 0.9993,
        alternatives: [{ transcript: ' me dá o briefing da casa hoje ', confidence: 0.98 }],
      },
    ],
  },
};

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('buildListenQuery', () => {
  it('asks for detection when the language is auto', () => {
    const query = new URLSearchParams(buildListenQuery({ language: 'auto' }));
    expect(query.get('detect_language')).toBe('true');
    expect(query.get('language')).toBeNull();
    expect(query.get('model')).toBe(DEFAULT_STT_MODEL);
    expect(query.get('punctuate')).toBe('true');
    expect(query.get('utterances')).toBe('false');
  });

  it('pins an explicit language instead of detecting', () => {
    const query = new URLSearchParams(buildListenQuery({ language: 'en-US' }));
    expect(query.get('language')).toBe('en-US');
    expect(query.get('detect_language')).toBeNull();
  });

  it('carries domain keywords through', () => {
    const query = new URLSearchParams(buildListenQuery({ keywords: ['Mara', 'casa:2'] }));
    expect(query.get('keywords')).toBe('Mara,casa:2');
  });
});

describe('toTurnLanguage', () => {
  it.each([
    ['pt', 'pt'],
    ['pt-BR', 'pt'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['es', null],
    ['', null],
    [null, null],
  ])('maps %s -> %s', (input, expected) => {
    expect(toTurnLanguage(input as string | null)).toBe(expected);
  });
});

describe('parseListenResponse', () => {
  it('reads transcript, detected language, confidence and duration', () => {
    expect(parseListenResponse(OK_BODY)).toEqual({
      text: 'me dá o briefing da casa hoje',
      detectedLanguage: 'pt',
      languageConfidence: 0.9993,
      confidence: 0.98,
      durationSec: 3.264,
    });
  });

  it('returns empty fields for a body with no channel', () => {
    expect(parseListenResponse({})).toMatchObject({ text: '', detectedLanguage: null });
    expect(parseListenResponse(null).text).toBe('');
  });
});

describe('silentWav', () => {
  it('is a valid mono 16-bit RIFF header with the requested length', () => {
    const wav = silentWav(100, 16000);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    // 100 ms at 16 kHz, 2 bytes per sample + 44 byte header
    expect(wav.length).toBe(44 + 1600 * 2);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });
});

describe('transcribeAudio', () => {
  it('POSTs the raw clip with the provider auth header and parses the transcript', async () => {
    const { impl, calls } = fakeFetch(async () => json(200, OK_BODY));
    const result = await transcribeAudio({
      audio: Buffer.alloc(2048, 3),
      mimetype: 'audio/webm;codecs=opus',
      language: 'auto',
      apiKey: 'test-key',
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('https://api.deepgram.com/v1/listen?');
    expect(calls[0].url).toContain('detect_language=true');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Token test-key');
    expect(headers['Content-Type']).toBe('audio/webm'); // codec stripped

    expect(result.ok).toBe(true);
    expect(result.text).toBe('me dá o briefing da casa hoje');
    expect(result.detectedLanguage).toBe('pt');
    expect(result.language).toBe('pt');
    expect(result.provider).toBe('deepgram');
    expect(typeof result.sttMs).toBe('number');
    expect(typeof result.providerMs).toBe('number');
    expect(result.bytes).toBe(2048);
  });

  it('passes an unknown language through as null so the caller keeps its own', async () => {
    const { impl } = fakeFetch(async () =>
      json(200, {
        metadata: { duration: 1.2 },
        results: { channels: [{ detected_language: 'es', alternatives: [{ transcript: 'hola' }] }] },
      }),
    );
    const result = await transcribeAudio({
      audio: Buffer.alloc(64, 1),
      language: 'auto',
      apiKey: 'k',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(result.detectedLanguage).toBe('es');
    expect(result.language).toBeNull();
  });

  it('reports a missing key without calling the provider', async () => {
    const { impl, calls } = fakeFetch(async () => json(200, OK_BODY));
    const result = await transcribeAudio({
      audio: Buffer.alloc(64, 1),
      apiKey: '',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_key');
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty upload', async () => {
    const { impl, calls } = fakeFetch(async () => json(200, OK_BODY));
    const result = await transcribeAudio({ audio: Buffer.alloc(0), apiKey: 'k', fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_audio');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a provider rejection as reason=http with its message', async () => {
    const { impl } = fakeFetch(async () =>
      json(401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials' }),
    );
    const result = await transcribeAudio({
      audio: Buffer.alloc(64, 1),
      apiKey: 'bad',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('http');
    expect(result.status).toBe(401);
    expect(result.detail).toBe('Invalid credentials');
    expect(result.text).toBe('');
  });

  it('surfaces a non-JSON body as bad_response, not as speech', async () => {
    const { impl } = fakeFetch(async () => new Response('<html>oops</html>', { status: 200 }));
    const result = await transcribeAudio({
      audio: Buffer.alloc(64, 1),
      apiKey: 'k',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_response');
    expect(result.text).toBe('');
  });
});
