/**
 * bargeIn — mic energy VAD that cuts the agent off when the member speaks.
 *
 * Barge-in has to feel like a conversation, not like pressing a button: while
 * the agent is speaking, two consecutive 50ms frames above the noise floor mean
 * "the human is talking now", and the reply is abandoned (playback AND the
 * upstream stream, via `agentVoice.stop()`).
 *
 * Deliberate limits:
 * - it listens only while a reply is speaking (`isSpeaking()`), so the mic is
 *   not held open all session;
 * - every dependency is injectable, and `simulateSpeech()` drives the exact same
 *   code path as a real detection — a headless rig with no microphone can still
 *   prove the abort latency honestly (reported as `reason: 'simulated'`).
 */

export type BargeInReason = 'vad' | 'simulated' | 'manual';

export interface BargeInOptions {
  /** True only while the agent is speaking; gates all detection. */
  isSpeaking: () => boolean;
  /** Called once per detected interruption. */
  onBargeIn: (reason: BargeInReason) => void;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContextImpl?: typeof AudioContext;
  /** RMS above this counts as speech (default 0.02 — a quiet room is ~0.003). */
  threshold?: number;
  /** Consecutive loud frames required (default 2 ≈ 100ms). */
  frames?: number;
  /** Analyser poll interval in ms (default 50). */
  intervalMs?: number;
  now?: () => number;
}

export interface BargeInHandle {
  /** Start the mic loop (idempotent). Resolves false when mic is unavailable. */
  start: () => Promise<boolean>;
  /** Release the mic and the audio context. */
  stop: () => void;
  /** Drive the same path a real detection takes (verification hook). */
  simulateSpeech: (reason?: BargeInReason) => number;
  /** Last detection timestamp (ms) — proof of when the cut was issued. */
  lastTriggeredAt: number | null;
  readonly listening: boolean;
}

export function installBargeIn(options: BargeInOptions): BargeInHandle {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const threshold = options.threshold ?? 0.02;
  const needed = options.frames ?? 2;
  const intervalMs = options.intervalMs ?? 50;

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let loudFrames = 0;
  let armed = true;

  const handle: BargeInHandle = {
    lastTriggeredAt: null,
    get listening() {
      return Boolean(timer);
    },
    async start() {
      if (timer) return true;
      const getUserMedia =
        options.getUserMedia ||
        (typeof navigator !== 'undefined' && navigator.mediaDevices
          ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
          : null);
      const Ctx =
        options.AudioContextImpl ||
        (typeof AudioContext !== 'undefined' ? AudioContext : undefined);
      if (!getUserMedia || !Ctx) return false;
      try {
        stream = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        context = new Ctx();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        timer = setInterval(() => {
          if (!armed || !options.isSpeaking()) {
            loudFrames = 0;
            return;
          }
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length);
          if (rms >= threshold) {
            loudFrames += 1;
            if (loudFrames >= needed) {
              loudFrames = 0;
              handle.simulateSpeech('vad');
            }
          } else {
            loudFrames = 0;
          }
        }, intervalMs);
        return true;
      } catch {
        handle.stop();
        return false;
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      armed = false;
      try {
        stream?.getTracks().forEach((track) => track.stop());
      } catch {
        /* tracks already gone */
      }
      stream = null;
      try {
        void context?.close();
      } catch {
        /* context already closed */
      }
      context = null;
    },
    simulateSpeech(reason: BargeInReason = 'simulated') {
      const at = now();
      handle.lastTriggeredAt = at;
      options.onBargeIn(reason);
      return at;
    },
  };

  return handle;
}
