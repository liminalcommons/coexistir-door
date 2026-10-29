/**
 * agentVoice.test.ts — client reply-playback controller (Coexistir slice 3B).
 *
 * The controller is where the "does the agent actually speak?" decision lives,
 * so the tests pin: default ON, persisted preference, no network when muted,
 * the exact server request shape, the playback state machine, autoplay
 * blocking, and the announce-a-reply event seam.
 */
import {
  AgentVoiceController,
  AGENT_REPLY_EVENT,
  AGENT_VOICE_ENABLED_KEY,
  COEXISTIR_AGENT_ID,
  installAgentReplyBridge,
  type AgentVoiceState,
} from '../agentVoice';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

interface FakeAudio {
  src: string;
  played: number;
  paused: number;
  onended: (() => void) | null;
  onerror: ((e?: unknown) => void) | null;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  finish(): void;
}

function makeAudioFactory(playImpl?: () => Promise<void>) {
  const created: FakeAudio[] = [];
  const factory = (src: string): FakeAudio => {
    const audio: FakeAudio = {
      src,
      played: 0,
      paused: 0,
      onended: null,
      onerror: null,
      currentTime: 0,
      play() {
        audio.played += 1;
        return playImpl ? playImpl() : Promise.resolve();
      },
      pause() {
        audio.paused += 1;
      },
      finish() {
        audio.onended?.();
      },
    };
    created.push(audio);
    return audio;
  };
  return { factory, created };
}

/**
 * jsdom (jest 30) has no `Response`, so provider responses are stubbed with the
 * only surface the controller touches: ok/status/headers.get/blob/json.
 */
function responseWithAudio(headers: Record<string, string> = {}): any {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    blob: async () => new Blob([new Uint8Array([0xff, 0xf3, 0x64, 0xc4])], { type: 'audio/mpeg' }),
    json: async () => ({}),
  };
}

function jsonResponse(status: number, body: unknown): any {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body,
    blob: async () => new Blob([]),
  };
}

describe('AgentVoiceController', () => {
  it('is ON by default so agent replies are audible out of the box', () => {
    const controller = new AgentVoiceController({ storage: new MemoryStorage() });
    expect(controller.isEnabled()).toBe(true);
    expect(controller.snapshot.phase).toBe('idle');
  });

  it('honours a persisted mute', () => {
    const storage = new MemoryStorage();
    storage.setItem(AGENT_VOICE_ENABLED_KEY, 'off');
    const controller = new AgentVoiceController({ storage });
    expect(controller.isEnabled()).toBe(false);
  });

  it('persists the toggle and notifies subscribers', () => {
    const storage = new MemoryStorage();
    const controller = new AgentVoiceController({ storage });
    const phases: AgentVoiceState[] = [];
    controller.subscribe((state) => phases.push(state));

    controller.setEnabled(false);
    expect(controller.isEnabled()).toBe(false);
    expect(storage.getItem(AGENT_VOICE_ENABLED_KEY)).toBe('off');
    expect(phases[phases.length - 1].phase).toBe('disabled');

    controller.setEnabled(true);
    expect(storage.getItem(AGENT_VOICE_ENABLED_KEY)).toBe('on');
  });

  it('does not call the server when muted', async () => {
    const fetchImpl = jest.fn();
    const { factory, created } = makeAudioFactory();
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: factory,
    });
    controller.setEnabled(false);

    const result = await controller.speak('Bom dia');
    expect(result).toMatchObject({ spoken: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('ignores empty replies', async () => {
    const fetchImpl = jest.fn();
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: makeAudioFactory().factory,
    });
    const result = await controller.speak('   ');
    expect(result.reason).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks the server for the coexistir agent in the requested language and plays the audio', async () => {
    const fetchImpl = jest.fn(async () =>
      responseWithAudio({ 'X-TTS-Language': 'pt-BR', 'X-TTS-Model-Id': 'flux-mariana-pt' }),
    );
    const { factory, created } = makeAudioFactory();
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: factory,
      createObjectUrl: () => 'blob:reply',
      revokeObjectUrl: () => undefined,
    });

    const result = await controller.speak('Bom dia! Tudo bem?', { language: 'pt-BR' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(String(url)).toBe('/api/tts/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      text: 'Bom dia! Tudo bem?',
      agentId: COEXISTIR_AGENT_ID,
      language: 'pt-BR',
    });

    expect(result.spoken).toBe(true);
    expect(result.modelId).toBe('flux-mariana-pt');
    expect(created).toHaveLength(1);
    expect(created[0].src).toBe('blob:reply');
    expect(created[0].played).toBe(1);
    expect(controller.snapshot.phase).toBe('speaking');
    expect(controller.snapshot.lastLanguage).toBe('pt-BR');
    expect(controller.snapshot.lastModelId).toBe('flux-mariana-pt');

    created[0].finish();
    expect(controller.snapshot.phase).toBe('idle');
    expect(controller.snapshot.spokenCount).toBe(1);
  });

  it('reports an unsupported language without playing anything', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(422, { error: 'unsupported_language', supportedLanguages: ['pt-BR', 'en'] }));
    const { factory, created } = makeAudioFactory();
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: factory,
    });

    const result = await controller.speak('Bonjour', { language: 'fr' });
    expect(result).toMatchObject({ spoken: false, reason: 'unsupported' });
    expect(controller.snapshot.phase).toBe('unsupported');
    expect(created).toHaveLength(0);
    expect(controller.snapshot.spokenCount).toBe(0);
  });

  it('reports provider failures as an error state, not a throw', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(500, { error: 'Deepgram TTS API error: 400' }));
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: makeAudioFactory().factory,
    });

    const result = await controller.speak('Bom dia');
    expect(result).toMatchObject({ spoken: false, reason: 'http', status: 500 });
    expect(controller.snapshot.phase).toBe('error');
  });

  it('survives a network failure', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    });
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: makeAudioFactory().factory,
    });
    const result = await controller.speak('Bom dia');
    expect(result.reason).toBe('error');
    expect(controller.snapshot.phase).toBe('error');
  });

  it('flags autoplay-blocked playback so the UI can ask for a tap', async () => {
    const fetchImpl = jest.fn(async () => responseWithAudio({ 'X-TTS-Language': 'pt-BR' }));
    const { factory } = makeAudioFactory(() => Promise.reject(new Error('NotAllowedError')));
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: factory,
      createObjectUrl: () => 'blob:reply',
      revokeObjectUrl: () => undefined,
    });

    const result = await controller.speak('Bom dia');
    expect(result).toMatchObject({ spoken: false, reason: 'blocked' });
    expect(controller.snapshot.phase).toBe('blocked');
  });

  it('stops and revokes the current clip when muted mid-sentence', async () => {
    const fetchImpl = jest.fn(async () => responseWithAudio({}));
    const { factory, created } = makeAudioFactory();
    const revoked: string[] = [];
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: factory,
      createObjectUrl: () => 'blob:reply',
      revokeObjectUrl: (url) => revoked.push(url),
    });

    await controller.speak('Bom dia');
    expect(controller.snapshot.phase).toBe('speaking');

    controller.setEnabled(false);
    expect(created[0].paused).toBe(1);
    expect(revoked).toEqual(['blob:reply']);
    expect(controller.snapshot.phase).toBe('disabled');
  });

  it('a newer reply supersedes the older one', async () => {
    const fetchImpl = jest.fn(async () => responseWithAudio({}));
    const { factory, created } = makeAudioFactory();
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createAudio: factory,
      createObjectUrl: () => 'blob:reply',
      revokeObjectUrl: () => undefined,
    });

    await controller.speak('first');
    await controller.speak('second');
    expect(created).toHaveLength(2);
    expect(created[0].paused).toBe(1);
    expect(controller.snapshot.phase).toBe('speaking');
    expect(controller.snapshot.spokenCount).toBe(0);
  });

  it('exposes the server voice profile for display', async () => {
    const profile = {
      enabled: true,
      provider: 'deepgram',
      voiceId: 'mariana',
      modelId: 'flux-mariana-pt',
      language: 'pt-BR',
      languages: ['pt-BR', 'en'],
      voiceName: 'Mariana',
      languageVoices: [{ language: 'pt-BR', provider: 'deepgram', voiceId: 'mariana', modelId: 'flux-mariana-pt' }],
    };
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => profile,
      blob: async () => new Blob([]),
    }));
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const loaded = await controller.loadProfile();
    expect(String((fetchImpl as jest.Mock).mock.calls[0][0])).toBe(`/api/tts/config/${COEXISTIR_AGENT_ID}`);
    expect(loaded?.language).toBe('pt-BR');
    expect(controller.snapshot.profile?.modelId).toBe('flux-mariana-pt');
  });
});

describe('installAgentReplyBridge', () => {
  function fakeTarget() {
    const handlers = new Map<string, EventListener>();
    return {
      addEventListener: (type: string, fn: EventListener) => handlers.set(type, fn),
      removeEventListener: (type: string) => handlers.delete(type),
      dispatch: (event: Event) => handlers.get(event.type)?.(event),
      handlers,
    };
  }

  it('speaks replies announced by any surface', async () => {
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: jest.fn(async () => responseWithAudio({})) as unknown as typeof fetch,
      createAudio: makeAudioFactory().factory,
      createObjectUrl: () => 'blob:reply',
      revokeObjectUrl: () => undefined,
    });
    const target = fakeTarget();
    const uninstall = installAgentReplyBridge(controller, target as unknown as Window);

    target.dispatch(
      new CustomEvent(AGENT_REPLY_EVENT, { detail: { text: 'Bom dia! Sua lista está pronta.', language: 'pt-BR' } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.snapshot.phase).toBe('speaking');
    expect(controller.snapshot.lastLanguage).toBe('pt-BR');

    uninstall();
    expect(target.handlers.size).toBe(0);
  });

  it('ignores empty or malformed announcements', async () => {
    const controller = new AgentVoiceController({
      storage: new MemoryStorage(),
      fetchImpl: jest.fn() as unknown as typeof fetch,
      createAudio: makeAudioFactory().factory,
    });
    const target = fakeTarget();
    installAgentReplyBridge(controller, target as unknown as Window);

    target.dispatch(new CustomEvent(AGENT_REPLY_EVENT, { detail: { text: '   ' } }));
    target.dispatch(new CustomEvent(AGENT_REPLY_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.snapshot.phase).toBe('idle');
  });
});
