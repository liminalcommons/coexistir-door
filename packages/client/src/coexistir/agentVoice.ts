/**
 * agentVoice — agent reply playback for the Coexistir room.
 *
 * The agent's replies are synthesized server-side (`POST /api/tts/preview` with
 * `agentId`), which resolves the per-agent voice profile + language to a real
 * voice variant (PT-BR -> Deepgram Flux Mariana). This module is the client
 * half: a persisted ON/OFF toggle (default ON), playback state for the UI, and
 * the seams other surfaces use to make a reply audible.
 *
 * Seams:
 * - `agentVoice.speak(text, { language })` — call it with any agent reply text.
 * - `window.dispatchEvent(new CustomEvent(AGENT_REPLY_EVENT, { detail: { text, language } }))`
 *   — how a chat/transcript surface announces a reply without importing us.
 *
 * Everything is injected (fetch, audio, storage) so the state machine is
 * testable in jsdom without real audio.
 */

import { RealtimeVoicePlayer, type RealtimeStartResult } from './realtimeVoice';

export const COEXISTIR_AGENT_ID = 'coexistir-manager';
export const AGENT_VOICE_ENABLED_KEY = 'castalia-agent-voice-enabled';
export const AGENT_REPLY_EVENT = 'castalia:agent-reply';
/**
 * Fired once per reply with the exact HTMLAudioElement the controller is about
 * to play. The Live2D stage taps it with a Web Audio analyser for lip sync.
 */
export const AGENT_AUDIO_EVENT = 'castalia:agent-audio';

export type VoicePhase =
  | 'idle'
  | 'loading'
  | 'speaking'
  | 'disabled'
  | 'unsupported'
  | 'blocked'
  | 'error';

export interface AgentVoiceVariant {
  language: string;
  provider: string;
  voiceId: string;
  modelId: string;
}

export interface AgentVoiceProfile {
  enabled: boolean;
  provider: string;
  voiceId: string;
  modelId: string;
  language: string;
  languages: string[];
  voiceName: string | null;
  languageVoices: AgentVoiceVariant[];
  isPreConfigured?: boolean;
}

export interface AgentVoiceState {
  enabled: boolean;
  phase: VoicePhase;
  profile: AgentVoiceProfile | null;
  /** Language of the last synthesis that came back from the server. */
  lastLanguage: string | null;
  /** Model that actually spoke the last clip (server header). */
  lastModelId: string | null;
  /** Player-facing message for the last failure, if any. */
  lastError: string | null;
  /** Bumped on every successful playback end, so UIs can react. */
  spokenCount: number;
}

export interface SpeakOptions {
  agentId?: string;
  language?: string;
  /** Join the audio to the bridge's turn row (server logs both steps). */
  turnId?: string;
  /** Which step of the turn this is (the bridge streams filler, then answer). */
  kind?: 'filler' | 'answer';
}

export interface SpeakResult {
  spoken: boolean;
  phase: VoicePhase;
  reason?: 'disabled' | 'empty' | 'http' | 'unsupported' | 'blocked' | 'error';
  status?: number;
  language?: string;
  modelId?: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface AudioHandle {
  src: string;
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
  currentTime?: number;
}

export interface AgentVoiceDeps {
  fetchImpl?: typeof fetch;
  createAudio?: (src: string) => AudioHandle;
  storage?: StorageLike | null;
  apiBase?: string;
  enabledByDefault?: boolean;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /**
   * 'buffered' (default) keeps the historical whole-clip path;
   * 'stream' plays the reply progressively from `/api/coexistir/voice/stream`
   * and makes `stop()` abort the upstream stream (barge-in).
   */
  transport?: VoiceTransport;
  /** Injected progressive player (tests / instrumentation). */
  realtime?: RealtimeVoicePlayer;
}

export type VoiceTransport = 'buffered' | 'stream';

/** Default ON: the room speaks unless someone turns it off. */
export function readEnabledPreference(storage: StorageLike | null | undefined, fallback = true): boolean {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(AGENT_VOICE_ENABLED_KEY);
    if (raw === 'off' || raw === 'false' || raw === '0') return false;
    if (raw === 'on' || raw === 'true' || raw === '1') return true;
    return fallback;
  } catch {
    return fallback;
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function browserApiBase(): string {
  const globalBase = (globalThis as unknown as { __CASTALIA_API_BASE__?: unknown }).__CASTALIA_API_BASE__;
  return typeof globalBase === 'string' ? globalBase : '';
}

function defaultCreateAudio(src: string): AudioHandle {
  const audio = new Audio(src);
  return audio as unknown as AudioHandle;
}

export class AgentVoiceController {
  private state: AgentVoiceState;
  private listeners = new Set<(state: AgentVoiceState) => void>();
  private current: AudioHandle | null = null;
  private currentUrl: string | null = null;
  private transport: VoiceTransport;
  private realtime: RealtimeVoicePlayer | null;
  private readonly deps: Required<Pick<AgentVoiceDeps, 'enabledByDefault'>> & AgentVoiceDeps;

  constructor(deps: AgentVoiceDeps = {}) {
    this.deps = { enabledByDefault: true, ...deps };
    this.transport = deps.transport || 'buffered';
    this.realtime = deps.realtime || null;
    this.state = {
      enabled: readEnabledPreference(deps.storage === undefined ? browserStorage() : deps.storage, this.deps.enabledByDefault),
      phase: 'idle',
      profile: null,
      lastLanguage: null,
      lastModelId: null,
      lastError: null,
      spokenCount: 0,
    };
  }

  get snapshot(): AgentVoiceState {
    return this.state;
  }

  subscribe(listener: (state: AgentVoiceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  /** Switch the room between progressive streaming and the buffered clip. */
  setTransport(transport: VoiceTransport): void {
    if (transport === this.transport) return;
    this.transport = transport;
    if (transport === 'stream') this.stop();
  }

  getTransport(): VoiceTransport {
    return this.transport;
  }

  /**
   * Unlock browser audio inside a user gesture (the door's TALK tap). Must be
   * called synchronously from the click handler: an AudioContext created
   * outside a gesture stays suspended and the first reply is silent.
   */
  async unlock(): Promise<boolean> {
    if (this.transport !== 'stream') return true; // <audio> needs no context
    return this.ensureRealtimePlayer().unlock();
  }

  /** True while audio is actually playing (barge-in gate). */
  isSpeaking(): boolean {
    if (this.transport === 'stream' && this.realtime?.isActive) return true;
    return this.state.phase === 'speaking';
  }

  /**
   * Output amplitude of the audio the room is hearing, 0..1. Only meaningful
   * while the streamed player has scheduled buffers; 0 otherwise.
   */
  getLevel(): number {
    return this.realtime?.level?.() ?? 0;
  }

  /** Resolves when the current streamed turn's audio has finished (or was cut). */
  whenEnded(timeoutMs = 20000): Promise<void> {
    return this.realtime?.whenEnded(timeoutMs) ?? Promise.resolve();
  }

  setEnabled(enabled: boolean, options: { persist?: boolean } = {}): void {
    const next = Boolean(enabled);
    if (next === this.state.enabled) return;
    this.state = { ...this.state, enabled: next, phase: next ? 'idle' : 'disabled', lastError: next ? null : this.state.lastError };
    if (options.persist !== false) {
      const storage = this.deps.storage === undefined ? browserStorage() : this.deps.storage;
      try {
        storage?.setItem(AGENT_VOICE_ENABLED_KEY, next ? 'on' : 'off');
      } catch {
        /* storage full / disabled — the in-memory toggle still works */
      }
    }
    if (!next) this.stop();
    this.emit();
  }

  /**
   * Speak an ordered plan (filler, then answer). Each step finishes before the
   * next starts, which is what makes "let me check the house list" land BEFORE
   * the real answer instead of on top of it.
   */
  async speakSequence(
    steps: ReadonlyArray<{ text: string; kind?: 'filler' | 'answer' }>,
    options: SpeakOptions = {},
  ): Promise<SpeakResult[]> {
    const results: SpeakResult[] = [];
    for (const step of steps) {
      const result = await this.speak(step.text, options);
      results.push(result);
      if (!result.spoken) break;
      await this.realtime?.whenEnded();
      if (this.state.phase === 'idle' || this.state.phase === 'error') break;
    }
    return results;
  }

  /** Fetch the server-side voice profile (language + model) for display. */
  async loadProfile(agentId: string = COEXISTIR_AGENT_ID): Promise<AgentVoiceProfile | null> {
    const fetchImpl = this.deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) return null;
    try {
      const response = await fetchImpl(`${this.apiBase()}/api/tts/config/${encodeURIComponent(agentId)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const profile = (await response.json()) as AgentVoiceProfile;
      this.state = { ...this.state, profile };
      this.emit();
      return profile;
    } catch {
      return null;
    }
  }

  /**
   * Speak one agent reply. No-ops (and reports why) when the toggle is off.
   * Never throws — a failed reply must not break the conversation.
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
    const reply = (text || '').trim();
    if (!reply) return { spoken: false, phase: this.state.phase, reason: 'empty' };
    if (!this.state.enabled) {
      this.state = { ...this.state, phase: 'disabled' };
      this.emit();
      return { spoken: false, phase: 'disabled', reason: 'disabled' };
    }

    if (this.transport === 'stream') {
      return this.speakProgressive(reply, options);
    }

    const fetchImpl = this.deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) {
      this.state = { ...this.state, phase: 'error', lastError: 'fetch unavailable' };
      this.emit();
      return { spoken: false, phase: 'error', reason: 'error' };
    }

    this.stop('superseded');
    this.state = { ...this.state, phase: 'loading', lastError: null };
    this.emit();

    let response: Response;
    try {
      response = await fetchImpl(`${this.apiBase()}/api/tts/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: reply,
          agentId: options.agentId || COEXISTIR_AGENT_ID,
          language: options.language,
        }),
      });
    } catch (error) {
      this.state = { ...this.state, phase: 'error', lastError: 'network error' };
      this.emit();
      return { spoken: false, phase: 'error', reason: 'error' };
    }

    if (response.status === 422) {
      // Server has no voice for the requested language: keep the reply on screen.
      let supported: string[] = [];
      try {
        const body = (await response.json()) as { supportedLanguages?: string[] };
        supported = body.supportedLanguages || [];
      } catch {
        /* body is optional */
      }
      this.state = {
        ...this.state,
        phase: 'unsupported',
        lastError: supported.length ? `no voice for ${options.language}` : 'no voice for this language',
      };
      this.emit();
      return { spoken: false, phase: 'unsupported', reason: 'unsupported', status: 422 };
    }

    if (!response.ok) {
      this.state = { ...this.state, phase: 'error', lastError: `tts http ${response.status}` };
      this.emit();
      return { spoken: false, phase: 'error', reason: 'http', status: response.status };
    }

    const language = response.headers?.get?.('X-TTS-Language') || options.language || null;
    const modelId = response.headers?.get?.('X-TTS-Model-Id') || null;

    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      this.state = { ...this.state, phase: 'error', lastError: 'audio decode failed' };
      this.emit();
      return { spoken: false, phase: 'error', reason: 'error' };
    }

    const createObjectUrl = this.deps.createObjectUrl
      || (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? (b: Blob) => URL.createObjectURL(b)
        : null);

    if (!createObjectUrl) {
      this.state = { ...this.state, phase: 'error', lastError: 'object URLs unavailable' };
      this.emit();
      return { spoken: false, phase: 'error', reason: 'error' };
    }

    const url = createObjectUrl(blob);
    const audio = (this.deps.createAudio || defaultCreateAudio)(url);
    audio.src = url;
    this.current = audio;
    this.currentUrl = url;

    const finish = (phase: VoicePhase, error: string | null) => {
      if (this.current !== audio) return; // superseded by a newer reply
      this.current = null;
      this.releaseUrl(url);
      this.state = {
        ...this.state,
        phase,
        lastError: error,
        lastLanguage: language,
        lastModelId: modelId,
        spokenCount: phase === 'idle' ? this.state.spokenCount + 1 : this.state.spokenCount,
      };
      this.emit();
    };

    audio.onended = () => finish('idle', null);
    audio.onerror = () => finish('error', 'playback error');

    // Announce the exact element before playback so a visual surface can tap it
    // with an analyser; tap failures must never block the reply.
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent(AGENT_AUDIO_EVENT, { detail: { audio } }));
      }
    } catch {
      /* custom events unavailable: lipsync simply stays closed */
    }

    try {
      await audio.play();
    } catch {
      // Autoplay policy: the reply must be re-triggered by a gesture.
      this.current = null;
      this.releaseUrl(url);
      this.state = { ...this.state, phase: 'blocked', lastError: 'autoplay blocked', lastLanguage: language, lastModelId: modelId };
      this.emit();
      return { spoken: false, phase: 'blocked', reason: 'blocked', language: language || undefined, modelId: modelId || undefined };
    }

    this.state = { ...this.state, phase: 'speaking', lastLanguage: language, lastModelId: modelId };
    this.emit();
    return { spoken: true, phase: 'speaking', language: language || undefined, modelId: modelId || undefined };
  }

  /**
   * Progressive path: hand the reply to the streaming player and translate its
   * lifecycle into the same AgentVoiceState the UI already listens to.
   */
  private async speakProgressive(reply: string, options: SpeakOptions): Promise<SpeakResult> {
    this.stop();
    this.state = { ...this.state, phase: 'loading', lastError: null };
    this.emit();

    const player = this.ensureRealtimePlayer();
    const result: RealtimeStartResult = await player.speak(reply, {
      language: options.language,
      agentId: options.agentId || COEXISTIR_AGENT_ID,
      turnId: options.turnId,
      kind: options.kind,
    });

    if (!result.ok) {
      const phase: VoicePhase =
        result.reason === 'unsupported' ? 'unsupported'
          : result.reason === 'blocked' ? 'blocked'
            : result.reason === 'http' ? 'error'
              : 'error';
      this.state = {
        ...this.state,
        phase,
        lastError:
          result.reason === 'unsupported'
            ? `no voice for ${options.language || 'this language'}`
            : `tts http ${result.status ?? 'error'}`,
      };
      this.emit();
      return {
        spoken: false,
        phase,
        reason: result.reason === 'unsupported' ? 'unsupported' : 'error',
        status: result.status,
      };
    }

    // The player can finish before speak() resolves (a short clip / a cut).
    // Never overwrite the idle state `onEnded` already published.
    const stillPlaying = player.isActive;
    const phase: VoicePhase = stillPlaying ? 'speaking' : 'idle';
    this.state = {
      ...this.state,
      phase,
      lastLanguage: result.language || options.language || null,
      lastModelId: result.modelId || null,
    };
    this.emit();
    return {
      spoken: true,
      phase,
      language: result.language || options.language,
      modelId: result.modelId,
    };
  }

  private ensureRealtimePlayer(): RealtimeVoicePlayer {
    if (this.realtime) return this.realtime;
    this.realtime = new RealtimeVoicePlayer({
      apiBase: this.deps.apiBase,
      fetchImpl: this.deps.fetchImpl,
      onEnded: () => {
        this.state = { ...this.state, phase: 'idle', spokenCount: this.state.spokenCount + 1 };
        this.emit();
      },
      onError: (message) => {
        this.state = { ...this.state, phase: 'error', lastError: message };
        this.emit();
      },
    });
    return this.realtime;
  }

  stop(reason = 'manual'): void {
    if (this.realtime?.isActive) {
      // Barge-in: aborts the HTTP stream, so the server aborts Deepgram.
      this.realtime.stop(reason);
    }
    if (this.current) {
      try {
        this.current.pause();
        this.current.currentTime = 0;
      } catch {
        /* element already detached */
      }
      if (this.currentUrl) this.releaseUrl(this.currentUrl);
      this.current = null;
      this.currentUrl = null;
    }
    if (this.state.phase === 'speaking' || this.state.phase === 'loading') {
      this.state = { ...this.state, phase: this.state.enabled ? 'idle' : 'disabled' };
      this.emit();
    }
  }

  private releaseUrl(url: string): void {
    try {
      const revoke = this.deps.revokeObjectUrl
        || (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL : null);
      revoke?.(url);
    } catch {
      /* never let cleanup throw */
    }
  }

  private apiBase(): string {
    const base = this.deps.apiBase;
    if (typeof base === 'string') return base;
    return browserApiBase();
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(this.state);
      } catch {
        /* a broken subscriber must not break playback */
      }
    }
  }
}

export const agentVoice = new AgentVoiceController();

/**
 * Listen for agent replies announced by any surface:
 *   window.dispatchEvent(new CustomEvent(AGENT_REPLY_EVENT, { detail: { text, language } }))
 * Returns an uninstall function.
 */
export function installAgentReplyBridge(
  controller: AgentVoiceController = agentVoice,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = typeof window !== 'undefined' ? window : null,
): () => void {
  if (!target) return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ text?: string; language?: string }>).detail;
    if (!detail || typeof detail.text !== 'string' || !detail.text.trim()) return;
    void controller.speak(detail.text, { language: detail.language });
  };
  target.addEventListener(AGENT_REPLY_EVENT, handler as EventListener);
  return () => target.removeEventListener(AGENT_REPLY_EVENT, handler as EventListener);
}
