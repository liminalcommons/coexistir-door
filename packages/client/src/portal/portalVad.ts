/**
 * portalVad — the door's ALWAYS-ON ear.
 *
 * Owner's lock (2026-10-28): the mic is not a button that starts and stops a
 * recording. Tapping MIC opens the ear, and the ear STAYS open. Speech starts
 * an utterance, a pause ends it, and the clip is sent by itself. The visitor
 * never taps to send, and the mic never closes after a turn.
 *
 * Why energy VAD here and not Deepgram streaming: it used to be the whole ear.
 * Now it is the LOCAL half of a hybrid, and the split is deliberate:
 *
 *   - the VAD still owns level, onset and BARGE-IN. Those are latency-critical
 *     and must not wait for a network round trip: a click that is 300 ms late is
 *     a barge-in that does not happen;
 *   - the provider (`portalSttStream` -> `deepgramStream`) owns END OF TURN. Its
 *     endpointing is a language model saying "that was a sentence", not a timer
 *     saying "it has been quiet for 1.2 s" — measured ~630 ms from the last
 *     sample of speech instead of ~1750 ms.
 *
 * When the stream cannot open, the graph below is still complete on its own: the
 * VAD's own utterance (this file) feeds the batch ear. So this file remains a
 * working ear, not a vestige.
 *
 *   persistent stream ─▶ AudioWorklet tap (AUDIO thread, 2048 @ 48 kHz ≈ 43 ms)
 *     ─▶ blocks posted to the page ─▶ RMS per block ─▶ adaptive noise floor
 *     ─▶ onset / end-of-speech ─▶ pre-roll + voiced frames ─▶ 16 kHz mono WAV
 *     ─▶ /voice/stt
 *
 * Capture moved OFF the main thread (review #5). It used to be a
 * `ScriptProcessorNode`, whose callback only runs when the page's main thread is
 * free: with the Live2D stage drawing on that same thread, a stall (a resize, a
 * GC, a texture upload) delivered audio in late bursts and left the ear blind
 * for the length of the stall — measured at 356 ms / 1.47 s / 2.98 s of no
 * frames for 400 ms / 1.5 s / 3 s main-thread stalls (see door-audio-ramp.mjs).
 * The worklet runs on the audio thread, so every block is captured and stamped
 * with AUDIO time; a stalled page drains a queue afterwards instead of missing
 * the visitor's first syllable. `stats` below reports what that queue cost
 * (`lateMs`, `droppedMs`, `gaps`) instead of hiding it.
 *
 * Timings (all tunable in `VAD_DEFAULTS`):
 *   onset        2 loud frames          ≈  85 ms above the bar
 *   the bar      max(speechRms, room × 2.6), CEILING = loudest block × 0.5
 *                — an adaptive floor may not demand a bar that a real voice in
 *                this room cannot clear (the owner's live door: −27 dBFS voice,
 *                OUVINDO, no turn);
 *   end of speech 1200 ms of silence    — the owner's "~1.2 s", measured from
 *                                         the last VOICED frame, where voiced
 *                                         means above `room × 1.15` (NOT a
 *                                         fraction of the speech bar: that sat
 *                                         under the room and no clip ever closed)
 *   pre-roll      500 ms                — audio from before the onset frame, so
 *                                         the first syllable is not clipped
 *   min speech    350 ms                — shorter is a cough, dropped silently
 *   headroom      400 ms                — a capture that never exceeds bar × 1.2
 *                                         was the room; cancelled, not billed
 *   max segment   20 s                  — a stuck-open ear still sends
 *
 * Barge-in is the same detector: while she is speaking, an onset at a HIGHER
 * bar (×1.7, 3 frames ≈ 128 ms) means the visitor has the floor. The session
 * tells the page, the page cuts her audio, and the words that did the cutting
 * are still captured — an interruption is also the next question.
 *
 * Everything is injectable (`getUserMedia`, `AudioContextImpl`, `now`), and the
 * core takes plain frames, so the whole state machine is unit-tested without a
 * microphone and the headless rig can drive it with a fake capture device.
 */

import { classifyMicError, levelFromRms, SILENT_RMS, type MicErrorKind } from './earState';

export interface VadConfig {
  /** RMS that always counts as speech, whatever the room's floor. */
  speechRms: number;
  /** Speech must be this many times the measured floor (adaptive rooms). */
  noiseMargin: number;
  /**
   * The bar may never sit above this fraction of the LOUDEST block the ear has
   * heard. A voice is the loudest thing in a room, so this is the ceiling that
   * keeps an adaptive floor from climbing past a real speaker: with a laptop
   * microphone whose AGC lifts room tone to −32 dBFS, `floor × noiseMargin`
   * lands at −24 dBFS and a normal speaking voice at −27 dBFS can never clear
   * it — the door reads OUVINDO with the meter moving and no turn is ever
   * formed. Whatever the room, a block that is the session's loudest must open
   * an utterance.
   */
  peakBarFraction: number;
  /**
   * End-of-speech bar, as a multiple of the measured ROOM floor (which is the
   * quietest block of the last 2 s, so it sits ~3 dB under the room's mean —
   * hence 2×, i.e. ~6 dB above the quietest block). It used to be `0.55 × the
   * speech bar`, which in any room with tone (room tone above −43 dBFS — what
   * AGC does to a quiet office) sits UNDER the room, so a capture opened once
   * never closed: `sent` stayed 0, no clip was posted and the fallback ear was
   * dead too. Silence has to be measured against the room, not against the
   * speech gate.
   */
  floorMargin: number;
  /** An utterance must reach bar × this, or it was the room, not a voice. */
  onsetHeadroom: number;
  /** How long a new capture has to prove it (see onsetHeadroom). */
  onsetHeadroomMs: number;
  /** Consecutive loud frames that open an utterance. */
  startFrames: number;
  /** Silence that closes an utterance and sends it. THE number. */
  endSilenceMs: number;
  /** Voiced audio below this cannot contain a word: dropped, not sent. */
  minSpeechMs: number;
  /**
   * Longest single voiced RUN required. A door slam, a cough or the plosive at
   * the head of a clip is one or two loud frames; a spoken syllable is several
   * in a row. This is what stops a click from buying a Deepgram call.
   */
  minVoicedRunMs: number;
  /** A stuck-open segment is cut here, so the ear cannot record forever. */
  maxSpeechMs: number;
  /** Audio kept from BEFORE the onset frame, so the first syllable survives. */
  preRollMs: number;
  /** Extra loudness required to interrupt her (her own voice is loud). */
  bargeInMargin: number;
  /** Consecutive loud frames required to interrupt her. */
  bargeInFrames: number;
  /** Samples per audio callback. */
  frameSize: number;
  /** Sample rate of the WAV the ear receives. */
  outRate: number;
  /** Trailing silence kept on a clip (Deepgram wants a little air). */
  tailMs: number;
}

/** Window of the room estimate. Long enough to contain a speech gap. */
export const ROOM_WINDOW_MS = 2000;

export const VAD_DEFAULTS: VadConfig = {
  speechRms: 0.012,
  noiseMargin: 2.6,
  peakBarFraction: 0.7,
  floorMargin: 2.0,
  onsetHeadroom: 1.2,
  onsetHeadroomMs: 400,
  startFrames: 2,
  endSilenceMs: 1200,
  minSpeechMs: 350,
  minVoicedRunMs: 150,
  maxSpeechMs: 20000,
  preRollMs: 500,
  bargeInMargin: 1.7,
  bargeInFrames: 3,
  frameSize: 2048,
  outRate: 16000,
  tailMs: 220,
};

export interface Utterance {
  /** Mono PCM frames, in order, at `sampleRate`. */
  parts: Float32Array[];
  sampleRate: number;
  /** Voiced time (frames above the continuation bar), for the min guard. */
  speechMs: number;
  /** Total captured audio, pre-roll + speech + tail. */
  totalMs: number;
  /** Wall time of the LAST voiced frame: the honest end of speech. */
  endAtMs: number;
  reason: 'silence' | 'cap';
}

export type VadEvent =
  | { type: 'onset'; tMs: number; bargeIn: boolean; rms: number }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'discard'; tMs: number; speechMs: number; reason: 'tooShort' | 'roomLevel' };

interface Frame {
  samples: Float32Array;
  /** duration in ms */
  ms: number;
  tMs: number;
  rms: number;
}

function rmsOf(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

/**
 * The state machine. Feed it frames; it decides when speech started, when it
 * ended, and which audio belongs to the utterance — including the pre-roll.
 */
export class VadCore {
  private readonly cfg: VadConfig;
  private readonly frameMs: number;
  private readonly roll: Frame[] = [];
  private capture: Frame[] = [];
  private noiseFloor = 0.004;
  /** Last 2 s of block RMS: the room is the quietest of them (minimum statistics). */
  private recentRms: number[] = [];
  private readonly roomWindow: number;
  private loudFrames = 0;
  private capturing = false;
  private silenceMs = 0;
  private voicedMs = 0;
  /** Current and longest run of consecutive voiced frames (see minVoicedRunMs). */
  private voicedRunMs = 0;
  private maxVoicedRunMs = 0;
  private lastVoiceAt = 0;
  private lastLevelAt = -Infinity;
  /** Loudest frame of the utterance in progress (see onsetHeadroom). */
  private uttPeak = 0;
  /** When the capture opened, for the headroom deadline. */
  private uttStartMs = 0;

  /** Counters the page/debug strip reads; they are measurements, not guesses. */
  readonly stats = {
    frames: 0,
    onsets: 0,
    bargeIns: 0,
    sent: 0,
    discarded: 0,
    lastSpeechMs: 0,
    lastTotalMs: 0,
    lastEndAtMs: 0,
    lastReason: '' as '' | 'silence' | 'cap' | 'tooShort' | 'roomLevel',
    noiseFloor: 0.004,
    threshold: VAD_DEFAULTS.speechRms,
    /** End-of-speech bar: the room's level, not a fraction of the speech bar. */
    voiceBar: VAD_DEFAULTS.speechRms * 0.55,
    /** Loudest block since the ear opened: the answer to "is audio arriving?". */
    maxRms: 0,
    lastRms: 0,
    /** Frames that reached the bar — onset ATTEMPTS, including failed ones. */
    barHits: 0,
    /** Frames near the bar (>= 55%) that never opened an utterance. */
    nearMisses: 0,
    /** Captures cancelled because they never got louder than the room. */
    roomOnsets: 0,
    lastOnsetAt: 0,
  };

  constructor(config: Partial<VadConfig> = {}, sampleRate = 48000) {
    this.cfg = { ...VAD_DEFAULTS, ...config };
    this.frameMs = (this.cfg.frameSize / sampleRate) * 1000;
    this.roomWindow = Math.max(4, Math.round(ROOM_WINDOW_MS / this.frameMs));
    this.noiseFloor = 0.004;
  }

  /**
   * The onset bar. Three rules, in order:
   *   1. never below the fixed speech floor (a dead-quiet room still needs a bar);
   *   2. proportional to the measured room (`floor × noiseMargin`);
   *   3. never above `peak × peakBarFraction` — the loudest block the ear has
   *      heard. Rule 3 is what makes the bar reachable by an actual speaker: an
   *      adaptive floor measured from an AGC-lifted room can want a bar higher
   *      than the visitor's own voice, and then the door is deaf while its meter
   *      is full.
   */
  get threshold(): number {
    const adaptive = this.noiseFloor * this.cfg.noiseMargin;
    // Biased toward HEARING: an energy gate that calls a fan a voice costs one
    // discarded clip, while one that calls a voice a fan costs the whole visit.
    const ceiling = Math.max(this.cfg.speechRms, this.stats.maxRms * this.cfg.peakBarFraction);
    return Math.min(Math.max(adaptive, this.cfg.speechRms), ceiling);
  }

  /**
   * End-of-speech bar: what counts as a voiced frame once a clip is recording.
   * Tied to the ROOM, not to the speech bar — otherwise a room louder than
   * `0.55 × bar` never accumulates silence and the utterance stays open until
   * the 20 s cap (measured: `sent` stuck at 0 over a whole session, so the
   * fallback ear posted nothing).
   */
  get voiceBar(): number {
    // Capped at the onset bar: a frame that was loud enough to open an utterance
    // must count as voiced, or the clip closes with `voicedMs` at zero and the
    // min-speech guard throws away the visitor's first word.
    const roomLed = Math.min(this.noiseFloor * this.cfg.floorMargin, this.threshold * 0.95);
    return Math.max(roomLed, SILENT_RMS);
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * One audio callback. `speaking` is whether SHE is audible right now; it
   * raises the bar so her own voice cannot barge her in.
   *
   * Returns the events this frame produced (usually none).
   */
  push(samples: Float32Array, tMs: number, speaking = false): VadEvent[] {
    const events: VadEvent[] = [];
    const frame: Frame = { samples, ms: this.frameMs, tMs, rms: rmsOf(samples) };
    this.stats.frames += 1;
    this.stats.lastRms = frame.rms;
    if (frame.rms > this.stats.maxRms) this.stats.maxRms = frame.rms;

    // --- the room's floor: the QUIETEST block of the last 2 s -----------------
    // Minimum statistics, not an average. An average follows whatever is loudest
    // for long enough — including the visitor's own voice — and the bar then
    // climbs to meet the speaker, which is the live failure this replaces
    // (measured: 2 detections for 12 spoken bursts, and 0 for a room whose tone
    // sat above the old silence bar). The minimum over 2 s is the room in both
    // directions: any pause in speech exposes it, and a fan never rises above
    // itself. It also converges during a capture, so no state is circular.
    this.recentRms.push(frame.rms);
    if (this.recentRms.length > this.roomWindow) this.recentRms.shift();
    this.noiseFloor = Math.max(0.0006, Math.min(0.03, Math.min(...this.recentRms)));
    this.stats.noiseFloor = this.noiseFloor;
    this.stats.threshold = this.threshold;
    this.stats.voiceBar = this.voiceBar;

    // --- pre-roll ring ------------------------------------------------------
    this.roll.push(frame);
    let kept = 0;
    for (let i = this.roll.length - 1; i >= 0; i -= 1) {
      kept += this.roll[i].ms;
      if (kept > this.cfg.preRollMs) {
        this.roll.splice(0, i);
        break;
      }
    }

    if (!this.capturing) {
      const bar = speaking ? this.threshold * this.cfg.bargeInMargin : this.threshold;
      const needed = speaking ? this.cfg.bargeInFrames : this.cfg.startFrames;
      if (frame.rms >= bar) {
        // An onset ATTEMPT is a measurement too: a voice that reaches the bar
        // but never accumulates `startFrames` is exactly what "the VAD never
        // fires" looks like from the outside.
        this.stats.barHits += 1;
        this.loudFrames += 1;
        if (this.loudFrames >= needed) {
          this.beginUtterance(tMs, speaking, frame.rms, events);
        }
      } else {
        this.loudFrames = 0;
        if (frame.rms >= bar * 0.55) this.stats.nearMisses += 1;
      }
      return events;
    }

    // --- capturing ----------------------------------------------------------
    this.capture.push(frame);
    if (frame.rms > this.uttPeak) this.uttPeak = frame.rms;
    // A quieter continuation bar keeps soft word endings inside the utterance.
    if (frame.rms >= this.voiceBar) {
      this.voicedMs += frame.ms;
      this.voicedRunMs += frame.ms;
      this.maxVoicedRunMs = Math.max(this.maxVoicedRunMs, this.voicedRunMs);
      this.lastVoiceAt = tMs;
      this.silenceMs = 0;
    } else {
      this.voicedRunMs = 0;
      this.silenceMs += frame.ms;
    }

    // A capture that never gets louder than the bar that opened it was the
    // room, not a voice (a steady loud room clears any energy bar now and then).
    // Cancelled inside 400 ms so a noisy room cannot buy a Deepgram call every
    // 20 s; a real syllable is at least 2× the bar by construction (see
    // threshold), so this cannot eat speech.
    // Only when the bar is ABOVE the fixed sensitivity floor: then it was driven
    // by the room, and a capture that never clears it by 20% was the room. With
    // the bar sitting exactly on the fixed floor, crossing it IS the definition
    // of speech, so a quiet voice at the floor is not thrown away.
    // Only when the bar is ABOVE the fixed sensitivity floor: then it was driven
    // by the room, and a capture that never clears it by 20% was the room. With
    // the bar sitting exactly on the fixed floor, crossing it IS the definition
    // of speech, so a quiet voice at the floor is not thrown away.
    // (A *steady* loud room can still hold one capture open until the 20 s cap —
    // an energy gate cannot tell a fan from a held vowel, and this one is built
    // to prefer hearing a person. The cap bounds the cost to one clip.)
    if (
      this.threshold > this.cfg.speechRms &&
      this.uttPeak < this.threshold * this.cfg.onsetHeadroom &&
      tMs - this.uttStartMs >= this.cfg.onsetHeadroomMs
    ) {
      this.stats.discarded += 1;
      this.stats.roomOnsets += 1;
      this.stats.lastReason = 'roomLevel';
      events.push({ type: 'discard', tMs, speechMs: this.voicedMs, reason: 'roomLevel' });
      this.reset();
      return events;
    }

    const capturedMs = this.capture.reduce((sum, f) => sum + f.ms, 0);
    if (capturedMs >= this.cfg.maxSpeechMs) {
      this.finish(tMs, 'cap', events);
      return events;
    }
    if (this.silenceMs >= this.cfg.endSilenceMs) {
      if (this.voicedMs < this.cfg.minSpeechMs || this.maxVoicedRunMs < this.cfg.minVoicedRunMs) {
        this.stats.discarded += 1;
        this.stats.lastReason = 'tooShort';
        events.push({ type: 'discard', tMs, speechMs: this.voicedMs, reason: 'tooShort' });
        this.reset();
        return events;
      }
      this.finish(tMs, 'silence', events);
    }
    return events;
  }

  /** Abort a segment without sending it (mic switched off mid-sentence). */
  cancel(): void {
    this.reset();
  }

  /** Level for the meter, throttled so React does not re-render per frame. */
  level(samples: Float32Array, tMs: number, throttleMs = 80): number | null {
    if (tMs - this.lastLevelAt < throttleMs) return null;
    this.lastLevelAt = tMs;
    // dBFS curve, not linear RMS: −60..0 dBFS across the whole meter, so a
    // working-but-quiet microphone lights it instead of reading as zero.
    return levelFromRms(rmsOf(samples));
  }

  private beginUtterance(tMs: number, bargeIn: boolean, rms: number, events: VadEvent[]): void {
    this.capturing = true;
    this.loudFrames = 0;
    this.stats.lastOnsetAt = tMs;
    this.silenceMs = 0;
    this.voicedMs = 0;
    // The pre-roll is the whole point: the words started before the trigger.
    this.capture = [...this.roll];
    this.voicedRunMs = 0;
    this.maxVoicedRunMs = 0;
    this.uttPeak = 0;
    this.uttStartMs = tMs;
    for (const frame of this.capture) {
      if (frame.rms > this.uttPeak) this.uttPeak = frame.rms;
      if (frame.rms >= this.voiceBar) {
        this.voicedMs += frame.ms;
        this.voicedRunMs += frame.ms;
        this.maxVoicedRunMs = Math.max(this.maxVoicedRunMs, this.voicedRunMs);
      } else {
        this.voicedRunMs = 0;
      }
    }
    this.lastVoiceAt = tMs;
    this.stats.onsets += 1;
    if (bargeIn) this.stats.bargeIns += 1;
    events.push({ type: 'onset', tMs, bargeIn, rms });
  }

  private finish(tMs: number, reason: 'silence' | 'cap', events: VadEvent[]): void {
    // A capture that ran to the CAP without ever rising above the room was a
    // steady loud room, not a monologue: 20 s of audio that never cleared
    // `room × floorMargin`. Discarded instead of sent, so a fan cannot bill the
    // provider every 20 s. (A voice that speaks for 20 s with no 1.2 s pause at
    // all is the one case this can misread, and such a clip is worth dropping.)
    if (reason === 'cap' && this.uttPeak < this.noiseFloor * this.cfg.floorMargin) {
      this.stats.discarded += 1;
      this.stats.roomOnsets += 1;
      this.stats.lastReason = 'roomLevel';
      events.push({ type: 'discard', tMs, speechMs: this.voicedMs, reason: 'roomLevel' });
      this.reset();
      return;
    }
    // Keep a little air after the last word, drop the rest of the pause: the
    // clip is what she needs, not 1.2 s of room tone.
    const keepTailFrames = Math.max(1, Math.round(this.cfg.tailMs / this.frameMs));
    let lastVoicedIndex = 0;
    for (let i = this.capture.length - 1; i >= 0; i -= 1) {
      if (this.capture[i].rms >= this.voiceBar) {
        lastVoicedIndex = i;
        break;
      }
    }
    const kept = this.capture.slice(0, Math.min(this.capture.length, lastVoicedIndex + keepTailFrames));
    const parts = kept.map((f) => f.samples);
    const totalMs = kept.reduce((sum, f) => sum + f.ms, 0);
    const utterance: Utterance = {
      parts,
      sampleRate: 0, // filled by the session, which owns the AudioContext
      speechMs: Math.round(this.voicedMs),
      totalMs: Math.round(totalMs),
      endAtMs: this.lastVoiceAt,
      reason,
    };
    this.stats.sent += 1;
    this.stats.lastSpeechMs = utterance.speechMs;
    this.stats.lastTotalMs = utterance.totalMs;
    this.stats.lastEndAtMs = utterance.endAtMs;
    this.stats.lastReason = reason;
    events.push({ type: 'utterance', utterance });
    this.reset();
  }

  private reset(): void {
    this.capturing = false;
    this.capture = [];
    this.roll.length = 0;
    this.silenceMs = 0;
    this.voicedMs = 0;
    this.voicedRunMs = 0;
    this.maxVoicedRunMs = 0;
    this.loudFrames = 0;
    this.uttPeak = 0;
  }
}

/** 16-bit PCM WAV, mono. Deepgram reads this directly (mimetype audio/wav). */
export function encodeWav(parts: Float32Array[], inputRate: number, outRate: number): Blob {
  const length = parts.reduce((sum, p) => sum + p.length, 0);
  const mono = new Float32Array(length);
  let at = 0;
  for (const part of parts) {
    mono.set(part, at);
    at += part.length;
  }

  const ratio = inputRate / outRate;
  const outLength = Math.max(1, Math.floor(mono.length / ratio));
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(mono.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += mono[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  writeText(36, 'data');
  view.setUint32(40, pcm.byteLength, true);

  return new Blob([header, pcm.buffer], { type: 'audio/wav' });
}

// --- the live session -------------------------------------------------------

/**
 * The AudioWorklet tap, as source text. It is inlined rather than shipped as a
 * separate asset so the kiosk cannot boot with a missing/!cached worklet file,
 * and so the code that runs on the audio thread is reviewable next to the code
 * that consumes it.
 *
 * It does three things, all on the audio thread:
 *   - accumulate the 128-sample render quanta into `frameSize` blocks,
 *   - stamp every block with AUDIO time, converted into the page's
 *     `performance.now()` clock at start (`tMs`), so VAD timings do not inherit
 *     main-thread lag,
 *   - post the block (transferred, no copy) with its peak.
 *
 * The VAD state machine stays on the page: it is cheap, it is unit-tested, and
 * a worklet that decides when to send would need its own message protocol back.
 */
export const VAD_TAP_SOURCE = `
class DoorEarTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.size = o.frameSize || 2048;
    this.epochPerf = o.epochPerf || 0;
    this.epochCtx = o.epochCtx || 0;
    this.buf = new Float32Array(this.size);
    this.fill = 0;
    this.blockStart = 0;
    this.index = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || ch.length === 0) return true;
    const dt = 1 / sampleRate;
    for (let i = 0; i < ch.length; i += 1) {
      if (this.fill === 0) this.blockStart = currentFrame / sampleRate + i * dt;
      this.buf[this.fill] = ch[i];
      this.fill += 1;
      if (this.fill === this.size) {
        const tMs = this.epochPerf + (this.blockStart - this.epochCtx) * 1000;
        let peak = 0;
        for (let k = 0; k < this.size; k += 1) {
          const v = this.buf[k] < 0 ? -this.buf[k] : this.buf[k];
          if (v > peak) peak = v;
        }
        this.port.postMessage(
          { type: 'block', samples: this.buf, tMs: tMs, peak: peak, index: this.index },
          [this.buf.buffer],
        );
        this.index += 1;
        this.buf = new Float32Array(this.size);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('door-ear-tap', DoorEarTap);
`;

export type CaptureMode = 'worklet' | 'script';

/**
 * Blocks whose timing is not judged for gaps. The first block of a worklet is
 * the one that establishes the audio epoch (`epochCtx` is read when the node is
 * constructed, and the context may still be spinning up), so the interval
 * between block 1 and block 2 carries that startup jitter — a gap there is a
 * calibration artifact, not a lost frame. Loss is judged by the SEQUENCE, which
 * has no such edge.
 */
const WARMUP_BLOCKS = 2;

/**
 * Which blocks the ear actually saw, in AUDIO time. This is the measurement the
 * Worklet change exists for: `gaps`/`maxGapMs` are discontinuities in the audio
 * timeline, `droppedMs` is audio the tap produced that never reached the page
 * (sequence jump; a worklet on the audio thread should never do this), and
 * `lateMs`/`queueMs` is how stale the newest block was when the page got to it —
 * main-thread starvation, absorbed by the queue instead of lost.
 */
export class BlockLedger {
  readonly mode: CaptureMode;
  readonly frameSize: number;
  readonly sampleRate: number;
  blocks = 0;
  gaps = 0;
  droppedMs = 0;
  maxGapMs = 0;
  lateMs = 0;
  queueMs = 0;
  peak = 0;
  /** The most recent block's peak, kept beside the running maximum. */
  lastPeak = 0;
  firstTMs: number | null = null;
  lastTMs: number | null = null;
  lastSeq: number | null = null;

  constructor(mode: CaptureMode, frameSize: number, sampleRate: number) {
    this.mode = mode;
    this.frameSize = frameSize;
    this.sampleRate = sampleRate;
  }

  get frameMs(): number {
    return (this.frameSize / (this.sampleRate || 48000)) * 1000;
  }

  /** Audio-time span this ledger covers, in ms. */
  get spanMs(): number {
    return this.firstTMs === null || this.lastTMs === null ? 0 : this.lastTMs - this.firstTMs;
  }

  /** Blocks the audio clock says should exist across `spanMs`. */
  get expectedBlocks(): number {
    return this.frameMs > 0 ? Math.round(this.spanMs / this.frameMs) + 1 : this.blocks;
  }

  push(seq: number, tMs: number, processedAtMs: number, peak = 0): void {
    this.blocks += 1;
    // `peak` is the LOUDEST block of the session, not the last one. Storing the
    // last block made a working ear read `peak 0` the moment a quiet block
    // landed, which is the opposite of what the number is for.
    this.lastPeak = peak;
    if (peak > this.peak) this.peak = peak;
    if (this.firstTMs === null) this.firstTMs = tMs;
    if (this.lastSeq !== null && seq > this.lastSeq + 1) {
      this.droppedMs += (seq - this.lastSeq - 1) * this.frameMs;
    }
    if (this.lastTMs !== null && this.blocks > WARMUP_BLOCKS) {
      const dt = tMs - this.lastTMs;
      if (dt > this.frameMs * 1.5) {
        this.gaps += 1;
        this.maxGapMs = Math.max(this.maxGapMs, dt);
      }
    }
    const late = processedAtMs - (tMs + this.frameMs);
    this.queueMs = late;
    if (late > this.lateMs) this.lateMs = late;
    this.lastTMs = tMs;
    this.lastSeq = seq;
  }
}

export interface PortalVadSnapshot {
  listening: boolean;
  threshold: number;
  noiseFloor: number;
  /** End-of-speech bar (room × floorMargin): a frame below this is silence. */
  voiceBar: number;
  onsets: number;
  bargeIns: number;
  sent: number;
  discarded: number;
  /** Captures cancelled because they never got louder than the room. */
  roomOnsets: number;
  lastSpeechMs: number;
  lastTotalMs: number;
  lastReason: string;
  endSilenceMs: number;
  sampleRate: number;
  /** Capture path actually in use. 'script' only after a worklet failure. */
  mode: CaptureMode | 'off';
  frames: number;
  frameSize: number;
  blocks: number;
  expectedBlocks: number;
  gaps: number;
  maxGapMs: number;
  droppedMs: number;
  lateMs: number;
  queueMs: number;
  peak: number;
  /** Loudest frame RMS since the ear opened (the honest "is audio arriving"). */
  maxRms: number;
  /** The last frame's RMS (live level for the dBFS readout). */
  lastRms: number;
  /** Frames that reached the speech bar — onset attempts, successful or not. */
  barHits: number;
  /** Frames near the bar (>= 55%) that never opened an utterance. */
  nearMisses: number;
  /** Audio-time of the last successful onset, or 0. */
  lastOnsetAt: number;
  /** `MediaStreamTrack.label` of the device actually captured, or ''. */
  deviceLabel: string;
}

export interface PortalVadOptions {
  /** True while Mara is audible; raises the bar and marks the onset barge-in. */
  isAgentSpeaking?: () => boolean;
  /**
   * Meter + measurement in one callback: the 0..1 value drives the EQ bars, the
   * RMS is what the numeric dBFS readout prints. Both come from the SAME frame,
   * so the bars and the number can never disagree.
   */
  onLevel?: (level: number, info: { rms: number; dbfs: number }) => void;
  /**
   * EVERY captured block, stamped with AUDIO time, before the VAD looks at it.
   * This is how the streaming ear (`portalSttStream`) gets the visitor's audio:
   * the VAD still decides barge-in and level, and the stream decides the turn,
   * from the SAME blocks — so the two can never disagree about what was said.
   */
  onFrame?: (samples: Float32Array, tMs: number, sampleRate: number) => void;
  onSpeechStart?: (info: { bargeIn: boolean; tMs: number }) => void;
  onUtterance?: (blob: Blob, info: { speechMs: number; totalMs: number; endAtMs: number; blobMs: number; reason: string; parts: Float32Array[]; sampleRate: number }) => void;
  onDiscard?: (info: { speechMs: number; reason: 'tooShort' | 'roomLevel' }) => void;
  /**
   * A capture failure, with its DOMException name classified: "denied" is a
   * browser decision the visitor can undo, "busy"/"no-device" are hardware, and
   * the door must say which one instead of printing "mic off" for all of them.
   */
  onError?: (message: string, info?: { name?: string; kind: MicErrorKind }) => void;
  /** Capture-path problems that do not stop the door (worklet fallback). */
  onWarn?: (message: string) => void;
  config?: Partial<VadConfig>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContextImpl?: typeof AudioContext;
  now?: () => number;
}

export interface PortalVadHandle {
  start: () => Promise<boolean>;
  stop: () => void;
  snapshot: () => PortalVadSnapshot;
  readonly listening: boolean;
}

export function createPortalVad(options: PortalVadOptions = {}): PortalVadHandle {
  const cfg: VadConfig = { ...VAD_DEFAULTS, ...options.config };
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;
  let core: VadCore | null = null;
  let ledger: BlockLedger | null = null;
  let listening = false;
  /** The device actually captured, so the rail can say which microphone it is. */
  let deviceLabel = '';

  /** One captured block, already stamped with audio time by the tap. */
  const consume = (samples: Float32Array, tMs: number, peak: number) => {
    if (!core) return;
    // The streaming ear gets the block FIRST. It is a copy-free handoff on the
    // same thread and must not depend on whether the VAD opens an utterance: a
    // turn the provider hears but the local energy gate misses still gets sent.
    options.onFrame?.(samples, tMs, ctx?.sampleRate ?? 48000);
    const speaking = options.isAgentSpeaking?.() === true;
    const level = core.level(samples, tMs);
    if (level !== null) {
      const rms = rmsOf(samples);
      // A digital zero is −∞ dBFS, not a clamped −120: the readout must not
      // invent a floor that a real microphone could be confused with.
      options.onLevel?.(level, { rms, dbfs: rms > 0 ? 20 * Math.log10(rms) : -Infinity });
    }

    const events = core.push(samples, tMs, speaking);
    for (const item of events) {
      if (item.type === 'onset') {
        options.onSpeechStart?.({ bargeIn: item.bargeIn, tMs: item.tMs });
      } else if (item.type === 'discard') {
        options.onDiscard?.({ speechMs: item.speechMs, reason: item.reason });
      } else {
        const utterance = item.utterance;
        utterance.sampleRate = ctx?.sampleRate ?? 48000;
        void peak;
        const endAt = utterance.endAtMs;
        // Encode off the audio path: a 20 s clip is ~10 ms of work, and holding
        // the queue open costs a drop-out on the meter.
        window.setTimeout(() => {
          const rate = utterance.sampleRate;
          const blob = encodeWav(utterance.parts, rate, cfg.outRate);
          options.onUtterance?.(blob, {
            speechMs: utterance.speechMs,
            totalMs: utterance.totalMs,
            endAtMs: endAt,
            blobMs: Math.round(now() - endAt),
            reason: utterance.reason,
            parts: utterance.parts,
            sampleRate: rate,
          });
        }, 0);
      }
    }
  };

  /**
   * Capture on the AUDIO thread. Every render quantum is copied whether or not
   * the page is busy; the page drains the queue afterwards. Returns false only
   * when this browser cannot run a worklet at all, so the caller can fall back.
   */
  const startWorklet = async (context: AudioContext, source: MediaStreamAudioSourceNode): Promise<boolean> => {
    if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([VAD_TAP_SOURCE], { type: 'application/javascript' }));
      await context.audioWorklet.addModule(url);
      const tap = new AudioWorkletNode(context, 'door-ear-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          frameSize: cfg.frameSize,
          epochPerf: now(),
          epochCtx: context.currentTime,
        },
      });
      ledger = new BlockLedger('worklet', cfg.frameSize, context.sampleRate);
      tap.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; samples?: Float32Array; tMs?: number; peak?: number; index?: number } | null;
        if (!data || data.type !== 'block' || !data.samples || typeof data.tMs !== 'number') return;
        ledger?.push(data.index ?? 0, data.tMs, now(), data.peak ?? 0);
        consume(data.samples, data.tMs, data.peak ?? 0);
      };
      source.connect(tap);
      tap.connect(sink as GainNode);
      node = tap;
      return true;
    } catch (err) {
      options.onWarn?.(
        `worklet capture unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to ScriptProcessor`,
      );
      node = null;
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  };

  /**
   * Fallback for browsers without AudioWorklet. Deprecated and main-thread, so
   * it reports `mode: 'script'` in every snapshot: a door running on it must be
   * visible as degraded, never silently mistaken for the real path.
   */
  const startScript = (context: AudioContext, source: MediaStreamAudioSourceNode): boolean => {
    try {
      const sp = context.createScriptProcessor(cfg.frameSize, 1, 1);
      ledger = new BlockLedger('script', cfg.frameSize, context.sampleRate);
      sp.onaudioprocess = (event: AudioProcessingEvent) => {
        const channel = event.inputBuffer.getChannelData(0);
        const samples = new Float32Array(channel.length);
        samples.set(channel);
        const t = now();
        let peak = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const v = Math.abs(samples[i]);
          if (v > peak) peak = v;
        }
        ledger?.push(ledger.blocks, t, t, peak);
        consume(samples, t, peak);
      };
      source.connect(sp);
      sp.connect(sink as GainNode);
      processor = sp;
      return true;
    } catch (err) {
      options.onError?.(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const handle: PortalVadHandle = {
    get listening() {
      return listening;
    },
    async start() {
      if (listening) return true;
      const getUserMedia =
        options.getUserMedia ??
        (typeof navigator !== 'undefined' && navigator.mediaDevices
          ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
          : null);
      const Ctx = options.AudioContextImpl ?? (typeof AudioContext !== 'undefined' ? AudioContext : undefined);
      if (!getUserMedia || !Ctx) {
        options.onError?.('this browser has no microphone API', {
          name: 'Unsupported',
          kind: 'unavailable',
        });
        return false;
      }
      try {
        stream = await getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        deviceLabel = stream.getAudioTracks()[0]?.label ?? '';
        ctx = new Ctx();
        void ctx.resume().catch(() => undefined);
        const source = ctx.createMediaStreamSource(stream);
        sink = ctx.createGain();
        sink.gain.value = 0;
        // A node with no path to the destination is not pulled.
        sink.connect(ctx.destination);
        core = new VadCore(cfg, ctx.sampleRate);

        const viaWorklet = await startWorklet(ctx, source);
        if (!viaWorklet && !startScript(ctx, source)) {
          handle.stop();
          return false;
        }

        listening = true;
        return true;
      } catch (err) {
        const name = err instanceof Error ? err.name : undefined;
        const message = err instanceof Error ? err.message : String(err);
        options.onError?.(message, { name, kind: classifyMicError(name, message) });
        handle.stop();
        return false;
      }
    },
    stop() {
      listening = false;
      if (processor) processor.onaudioprocess = null;
      try {
        if (node) {
          node.port.onmessage = null;
          node.port.close();
        }
      } catch {
        /* port already closed */
      }
      try {
        core?.cancel();
        node?.disconnect();
        processor?.disconnect();
        sink?.disconnect();
      } catch {
        /* already detached */
      }
      try {
        stream?.getTracks().forEach((track) => track.stop());
      } catch {
        /* device already gone */
      }
      try {
        void ctx?.close().catch(() => undefined);
      } catch {
        /* context already closed */
      }
      node = null;
      processor = null;
      sink = null;
      stream = null;
      ctx = null;
      core = null;
      ledger = null;
    },
    snapshot(): PortalVadSnapshot {
      const stats = core?.stats;
      return {
        listening,
        threshold: stats?.threshold ?? cfg.speechRms,
        noiseFloor: stats?.noiseFloor ?? 0,
        voiceBar: stats?.voiceBar ?? 0,
        onsets: stats?.onsets ?? 0,
        bargeIns: stats?.bargeIns ?? 0,
        sent: stats?.sent ?? 0,
        discarded: stats?.discarded ?? 0,
        roomOnsets: stats?.roomOnsets ?? 0,
        lastSpeechMs: stats?.lastSpeechMs ?? 0,
        lastTotalMs: stats?.lastTotalMs ?? 0,
        lastReason: stats?.lastReason ?? '',
        endSilenceMs: cfg.endSilenceMs,
        sampleRate: ctx?.sampleRate ?? ledger?.sampleRate ?? 0,
        mode: ledger?.mode ?? 'off',
        frames: stats?.frames ?? 0,
        frameSize: cfg.frameSize,
        blocks: ledger?.blocks ?? 0,
        expectedBlocks: ledger?.expectedBlocks ?? 0,
        gaps: ledger?.gaps ?? 0,
        maxGapMs: Math.round(ledger?.maxGapMs ?? 0),
        droppedMs: Math.round(ledger?.droppedMs ?? 0),
        lateMs: Math.round(ledger?.lateMs ?? 0),
        queueMs: Math.round(ledger?.queueMs ?? 0),
        peak: ledger?.peak ?? 0,
        maxRms: stats?.maxRms ?? 0,
        lastRms: stats?.lastRms ?? 0,
        barHits: stats?.barHits ?? 0,
        nearMisses: stats?.nearMisses ?? 0,
        lastOnsetAt: stats?.lastOnsetAt ?? 0,
        deviceLabel,
      };
    },
  };

  return handle;
}
