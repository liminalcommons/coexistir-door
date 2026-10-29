/**
 * audioMouth — turn a playing HTMLAudioElement into a 0..1 mouth value.
 *
 * The room's TTS audio is a blob URL played by AgentVoiceController. Web Audio
 * can tap that element with a MediaElementAudioSourceNode; we then read RMS
 * from an AnalyserNode every animation frame. The source must be connected to
 * the destination, otherwise routing the element through Web Audio silences
 * it — so the graph is source → analyser → destination with the analyser set
 * to pass-through.
 *
 * Browsers only allow an AudioContext after a user gesture; `resume()` is
 * retried on every `attach`, and a blocked context reports 0 (mouth stays
 * closed) rather than throwing.
 */

export interface MouthSource {
  /** Latest smoothed analytic amplitude, 0..1. */
  level(): number;
  detach(): void;
}

const FFT_SIZE = 1024;

export class AudioMouthTap {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array | null = null;
  private element: HTMLAudioElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private smoothed = 0;

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.context = new Ctor();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.55;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.analyser.connect(this.context.destination);
    return this.context;
  }

  /** Tap an element. Safe to call for every new reply; the old tap is dropped. */
  attach(element: HTMLAudioElement | null | undefined): boolean {
    if (!element) return false;
    if (this.element === element && this.source) return true;

    this.detachElement();
    const context = this.ensureContext();
    const analyser = this.analyser;
    if (!context || !analyser) return false;

    try {
      // createMediaElementSource throws if the element was already routed.
      this.source = context.createMediaElementSource(element);
    } catch {
      return false;
    }
    this.source.connect(analyser);
    this.element = element;

    if (context.state === 'suspended') {
      void context.resume().catch(() => undefined);
    }
    return true;
  }

  /** True while we have a live graph for a still-playing element. */
  get active(): boolean {
    return Boolean(this.source && this.element && !this.element.paused);
  }

  level(): number {
    const analyser = this.analyser;
    const buffer = this.buffer;
    if (!analyser || !buffer) return 0;
    if (!this.element || this.element.paused || this.element.ended) {
      this.smoothed *= 0.6;
      return this.smoothed < 0.01 ? 0 : this.smoothed;
    }
    analyser.getFloatTimeDomainData(buffer as unknown as Float32Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const sample = buffer[i];
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / buffer.length);
    // Speech RMS sits around 0.02-0.15; map it with headroom so the mouth
    // opens on vowels without sitting at 1.0 for the whole sentence.
    const target = Math.min(1, Math.max(0, (rms - 0.01) * 6));
    const smoothing = target > this.smoothed ? 0.6 : 0.25;
    this.smoothed += (target - this.smoothed) * smoothing;
    return this.smoothed;
  }

  detach(): void {
    this.detachElement();
  }

  private detachElement(): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.source = null;
    this.element = null;
    this.smoothed = 0;
  }
}
