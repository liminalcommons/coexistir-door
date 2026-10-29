/**
 * wavFixture — deterministic synthetic voices for the identity tests.
 *
 * The door uploads 16 kHz mono PCM WAV, so the tests generate exactly that: a
 * harmonic source shaped by three formant bumps, with a little noise so two
 * clips of the same voice are not byte-identical. Two "voices" differ in pitch
 * and vocal-tract length, which is what the fingerprint is supposed to notice.
 */

export interface VoiceSpec {
  /** Fundamental frequency (pitch). */
  f0: number;
  /** Formant centres in Hz (vocal-tract shape). */
  formants: [number, number, number];
  durationSec?: number;
  sampleRate?: number;
  /** Changes the noise realisation only: same speaker, different clip. */
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthVoice(spec: VoiceSpec): Float32Array {
  const rate = spec.sampleRate ?? 16_000;
  const duration = spec.durationSec ?? 2.4;
  const total = Math.round(rate * duration);
  const random = mulberry32(spec.seed ?? 1);
  const samples = new Float32Array(total);
  const harmonics = 18;

  for (let i = 0; i < total; i += 1) {
    const t = i / rate;
    let sample = 0;
    for (let h = 1; h <= harmonics; h += 1) {
      const freq = spec.f0 * h;
      if (freq > rate / 2 - 200) break;
      // Formant envelope: three resonances, summed (crude but voice-shaped).
      let gain = 0.02;
      for (const formant of spec.formants) {
        const distance = (freq - formant) / 180;
        gain += Math.exp(-distance * distance) / h;
      }
      sample += gain * Math.sin(2 * Math.PI * freq * t + h * 0.3);
    }
    // Syllable-rate amplitude modulation (3.4 Hz) + breath noise.
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.4 * t);
    sample = sample * envelope + (random() * 2 - 1) * 0.004;
    samples[i] = Math.max(-0.98, Math.min(0.98, sample * 0.35));
  }
  return samples;
}

export function wavFromSamples(samples: Float32Array, sampleRate = 16_000): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

export function voiceWav(spec: VoiceSpec): Buffer {
  return wavFromSamples(synthVoice(spec), spec.sampleRate ?? 16_000);
}

/** A voice with a low pitch and long tract — "the steward". */
export const VOICE_A: VoiceSpec = { f0: 112, formants: [720, 1240, 2560], seed: 11 };
/** Same speaker, different clip (other noise, other length). */
export const VOICE_A_AGAIN: VoiceSpec = { f0: 116, formants: [700, 1260, 2520], seed: 97, durationSec: 3.1 };
/** A clearly different voice: higher pitch, shorter tract. */
export const VOICE_B: VoiceSpec = { f0: 214, formants: [430, 1980, 3050], seed: 23 };
