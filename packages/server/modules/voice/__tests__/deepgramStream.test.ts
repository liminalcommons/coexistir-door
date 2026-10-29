/**
 * deepgramStream.test.ts — the streaming ear's contract, without a socket.
 *
 * Three things are asserted, and they are the three that can silently rot:
 *   1. what we ASK the provider for (endpointing, utterance_end, 16 kHz PCM);
 *   2. what we READ out of its frames (finals, speech_final, UtteranceEnd,
 *      word ends, detected language, errors);
 *   3. when a TURN exists — which is the whole point of the slice: end-of-turn
 *      comes from the provider, exactly once per utterance.
 */

import {
  BYTES_PER_MS,
  STREAM_AUTO_LANGUAGE,
  STREAM_DEFAULTS,
  StreamSession,
  buildStreamQuery,
  buildStreamUrl,
  openDeepgramStream,
  parseStreamMessage,
  type StreamEvent,
  type WsFactory,
  type WsLike,
} from '../deepgramStream';

const results = (over: Record<string, unknown> = {}) => ({
  type: 'Results',
  channel_index: [0, 1],
  start: 0,
  duration: 1.4,
  is_final: false,
  speech_final: false,
  channel: {
    alternatives: [{ transcript: 'quais são as', confidence: 0.94 }],
  },
  ...over,
});

const final = (over: Record<string, unknown> = {}) =>
  results({
    is_final: true,
    channel: {
      detected_language: 'pt',
      language_confidence: 0.99,
      alternatives: [
        {
          transcript: 'quais são as tarefas abertas',
          confidence: 0.97,
          words: [
            { word: 'quais', start: 0.1, end: 0.32 },
            { word: 'tarefas', start: 1.0, end: 1.42 },
            { word: 'abertas', start: 1.5, end: 1.98 },
          ],
        },
      ],
    },
    ...over,
  });

describe('buildStreamQuery', () => {
  it('asks for 16 kHz linear16 PCM with EXPLICIT endpointing and utterance_end', () => {
    const params = new URLSearchParams(buildStreamQuery());
    expect(params.get('model')).toBe('nova-3');
    expect(params.get('encoding')).toBe('linear16');
    expect(params.get('sample_rate')).toBe('16000');
    expect(params.get('channels')).toBe('1');
    expect(params.get('endpointing')).toBe('500');
    expect(params.get('utterance_end_ms')).toBe('1000');
    expect(params.get('interim_results')).toBe('true');
    expect(params.get('vad_events')).toBe('true');
  });

  it('detects the language when asked to, and pins it when a tag is given', () => {
    // Streaming `/v1/listen` rejects `detect_language` (400 on the handshake),
    // so `auto` maps onto nova-3's `multi` mode instead.
    const auto = new URLSearchParams(buildStreamQuery());
    expect(auto.get('language')).toBe(STREAM_AUTO_LANGUAGE);
    expect(auto.get('detect_language')).toBeNull();
    const pinned = new URLSearchParams(buildStreamQuery({ language: 'pt-BR' }));
    expect(pinned.get('language')).toBe('pt-BR');
  });

  it('lets the caller move the endpointing window without touching anything else', () => {
    const params = new URLSearchParams(buildStreamQuery({ endpointing: 300, utteranceEndMs: 800 }));
    expect(params.get('endpointing')).toBe('300');
    expect(params.get('utterance_end_ms')).toBe('800');
    expect(params.get('sample_rate')).toBe(String(STREAM_DEFAULTS.sampleRate));
  });

  it('builds a wss URL that carries no credential', () => {
    const url = buildStreamUrl({ model: 'nova-3' });
    expect(url.startsWith('wss://api.deepgram.com/v1/listen?')).toBe(true);
    expect(url).not.toMatch(/token|api_key|key=/i);
  });
});

describe('parseStreamMessage', () => {
  it('reads an interim transcript', () => {
    const event = parseStreamMessage(JSON.stringify(results()));
    expect(event).toMatchObject({ type: 'interim', text: 'quais são as' });
  });

  it('reads a final with the provider word ends (the end-of-speech base)', () => {
    const event = parseStreamMessage(JSON.stringify(final()));
    expect(event.type).toBe('final');
    if (event.type !== 'final') return;
    expect(event.text).toBe('quais são as tarefas abertas');
    expect(event.speechFinal).toBe(false);
    // last word `abertas` ends at 1.98 s -> 1980 ms on the audio clock.
    expect(event.wordsEndSec).toBe(1.98);
    expect(event.detectedLanguage).toBe('pt');
    expect(event.confidence).toBe(0.97);
    expect(event.audioSec).toBeCloseTo(1.4, 5);
  });

  it('marks the endpointed final (speech_final) so the page can close the turn', () => {
    const event = parseStreamMessage(JSON.stringify(final({ speech_final: true })));
    expect(event.type === 'final' && event.speechFinal).toBe(true);
  });

  it('reads VAD signals and UtteranceEnd', () => {
    expect(parseStreamMessage({ type: 'SpeechStarted', channel: [0], timestamp: 2.25 })).toEqual({
      type: 'speech_started',
      audioSec: 2.25,
    });
    expect(parseStreamMessage({ type: 'UtteranceEnd', channel: [0], last_word_end: 4.12 })).toEqual({
      type: 'utterance_end',
      audioSec: 4.12,
      lastWordEndSec: 4.12,
    });
  });

  it('reports provider errors instead of swallowing them', () => {
    const event = parseStreamMessage({ type: 'Error', description: 'bad audio', error_code: 'E1' });
    expect(event).toEqual({ type: 'error', message: 'bad audio', code: 'E1' });
  });

  it('does not throw on garbage, and says it did not understand', () => {
    expect(parseStreamMessage('not json').type).toBe('unknown');
    expect(parseStreamMessage(null).type).toBe('unknown');
    expect(parseStreamMessage({ type: 'KeepAlive' })).toEqual({ type: 'unknown', rawType: 'KeepAlive' });
  });
});

describe('StreamSession', () => {
  const finalEvent = (text: string, speechFinal: boolean, wordsEndSec: number | null = null): StreamEvent => ({
    type: 'final',
    text,
    audioSec: 1.4,
    speechFinal,
    wordsEndSec,
    detectedLanguage: 'pt',
    languageConfidence: 0.99,
    confidence: 0.95,
  });

  it('closes a turn on speech_final, once, with the provider word end', () => {
    const session = new StreamSession(() => 1000);
    expect(session.handle(finalEvent('quais são', false))).toBeNull();
    expect(session.handle(finalEvent('as tarefas abertas', true, 1.98))).not.toBeNull();
    // The SAME utterance then produces UtteranceEnd ~500 ms later: no 2nd turn.
    expect(session.handle({ type: 'utterance_end', audioSec: 1.98, lastWordEndSec: 1.98 })).toBeNull();
    expect(session.stats.turns).toBe(1);
  });

  it('joins every final of one utterance into the turn text', () => {
    const session = new StreamSession(() => 1000);
    session.handle(finalEvent('quais são', false));
    session.handle(finalEvent('as tarefas', false));
    const turn = session.handle(finalEvent('abertas', true, 2.1));
    expect(turn?.text).toBe('quais são as tarefas abertas');
    expect(turn?.finals).toBe(3);
    expect(turn?.by).toBe('speech_final');
    expect(turn?.lastWordEndSec).toBe(2.1);
  });

  it('falls back to UtteranceEnd when the provider never sends speech_final', () => {
    const session = new StreamSession(() => 2000);
    session.handle(finalEvent('me dá o briefing', false, 3.2));
    const turn = session.handle({ type: 'utterance_end', audioSec: 3.2, lastWordEndSec: 3.2 });
    expect(turn).not.toBeNull();
    expect(turn?.by).toBe('utterance_end');
    expect(turn?.text).toBe('me dá o briefing');
    // And a second UtteranceEnd has nothing left to close.
    expect(session.handle({ type: 'utterance_end', audioSec: 4, lastWordEndSec: 4 })).toBeNull();
  });

  it('reset() drops a half-spoken clip so mic-off cannot produce a turn', () => {
    const session = new StreamSession(() => 1000);
    session.handle(finalEvent('não quero', false));
    expect(session.hasPending).toBe(true);
    session.reset();
    expect(session.hasPending).toBe(false);
    expect(session.handle({ type: 'utterance_end', audioSec: 1, lastWordEndSec: 1 })).toBeNull();
    expect(session.stats.resets).toBe(1);
  });

  it('never invents a turn from silence', () => {
    const session = new StreamSession(() => 1000);
    expect(session.handle(finalEvent('', true))).toBeNull();
    expect(session.handle({ type: 'utterance_end', audioSec: 1, lastWordEndSec: 1 })).toBeNull();
    expect(session.stats.turns).toBe(0);
  });

  it('starts a new utterance when speech resumes after a closed turn', () => {
    const session = new StreamSession(() => 1000);
    session.handle(finalEvent('primeira pergunta', true, 1.2));
    session.handle({ type: 'speech_started', audioSec: 2.4 });
    session.handle(finalEvent('segunda pergunta', false, 3.3));
    const turn = session.handle(finalEvent('', true, 3.4));
    expect(turn?.text).toBe('segunda pergunta');
    expect(session.stats.turns).toBe(2);
  });
});

describe('openDeepgramStream', () => {
  function fakeSocket() {
    const sent: Array<{ data: unknown; binary?: boolean }> = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket: WsLike = {
      on(event, listener) {
        handlers.set(event, listener);
      },
      send(data, options) {
        sent.push({ data, binary: options?.binary });
      },
      close() {
        handlers.get('close')?.(1000, 'closed');
      },
    };
    return {
      socket,
      sent,
      emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    };
  }

  it('puts the key in the AUTHORIZATION HEADER and never in the URL', () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const factory: WsFactory = (url, init) => {
      seen.push({ url, headers: init.headers });
      return fakeSocket().socket;
    };
    openDeepgramStream({ apiKey: 'secret-key', WebSocketImpl: factory, onEvent: () => undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.Authorization).toBe('Token secret-key');
    expect(seen[0].url).not.toContain('secret-key');
  });

  it('refuses to open without a key and says why (the page then falls back)', () => {
    const errors: string[] = [];
    const opened: string[] = [];
    const transport = openDeepgramStream({
      apiKey: '',
      WebSocketImpl: (url) => {
        opened.push(url);
        return fakeSocket().socket;
      },
      onEvent: () => undefined,
      onError: (message) => errors.push(message),
    });
    expect(opened).toHaveLength(0);
    expect(errors).toEqual(['no_key']);
    expect(transport.closed).toBe(true);
  });

  it('keeps an audio clock from the bytes it accepted', () => {
    const transport = openDeepgramStream({
      apiKey: 'k',
      WebSocketImpl: () => fakeSocket().socket,
      onEvent: () => undefined,
    });
    const block = new Uint8Array(BYTES_PER_MS * 100); // 100 ms of 16 kHz PCM
    expect(transport.send(block)).toBe(block.byteLength);
    expect(transport.audioMs).toBe(100);
    expect(transport.send(new Uint8Array(0))).toBe(0);
  });

  it('drops provider frames through the parser into onEvent', () => {
    const fake = fakeSocket();
    const events: StreamEvent[] = [];
    openDeepgramStream({
      apiKey: 'k',
      WebSocketImpl: () => fake.socket,
      onEvent: (event) => events.push(event),
    });
    fake.emit('message', Buffer.from(JSON.stringify(final({ speech_final: true }))));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('final');
  });
});
