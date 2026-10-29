/**
 * acousticSnapshot — what a recorded clip can honestly say about a voice.
 *
 * The owner asked whether the STT WAV can yield an embedding/claim. It cannot,
 * and this module is the reason written down: there is no speaker-embedding
 * model in this stack (no ONNX runtime, no speaker model, no voiceprint store),
 * and Deepgram's batch endpoint returns text, not a speaker vector. Inventing a
 * "voice match" from an F0 estimate would be a lie with a number attached.
 *
 * What IS cheap and real: a few measured properties of the clip, computed in a
 * handful of milliseconds on the server while the response is already in hand —
 * median F0 (autocorrelation, 60–240 Hz), voicing ratio, spectral centroid and
 * level. They are a fingerprint in the everyday sense (two clips of two
 * different people usually differ) but NOT an identity: they are labelled
 * `not a voiceprint` everywhere they appear, and the panel prints the gap next
 * to them.
 *
 * Everything here is defensive: a WAV this parser cannot read returns null and
 * the row simply has no acoustics, rather than a fabricated set of numbers.
 */

export interface AcousticSnapshot {
  /** Clip length in seconds (from the WAV). */
  durationSec: number;
  /** Whole-clip RMS in dBFS (negative; −∞ clamped to −120). */
  rmsDb: number;
  /** Peak in dBFS. */
  peakDb: number;
  /** Median fundamental of the voiced frames, Hz. Null when nothing voiced. */
  f0Hz: number | null;
  /** Share of analysed frames that were voiced (0..1). */
  voicing: number;
  /** Median spectral centroid of the voiced frames, Hz. */
  centroidHz: number;
  /** Analysed frame count — so a 1-frame estimate is visibly weak. */
  frames: number;
  /** Hard label: this is a measurement, never an identity match. */
  note: 'acoustic snapshot, not a voiceprint';
}

const MIN_F0 = 60;
const MIN_RMS = 0.008;

/** Locate the `data` chunk and the format, tolerating extra chunks. */
function parseWav(buffer: Buffer): { pcm: Buffer; sampleRate: number; channels: number } | null {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(body + 2) || 1;
      sampleRate = buffer.readUInt32LE(body + 4) || 16000;
      bits = buffer.readUInt16LE(body + 14) || 16;
    } else if (id === 'data') {
      if (bits !== 16) return null;
      const end = Math.min(buffer.length, body + size);
      return { pcm: buffer.subarray(body, end), sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function toDb(value: number): number {
  if (value <= 0) return -120;
  return Math.round(20 * Math.log10(value) * 10) / 10;
}

/** Goertzel magnitude at one frequency — cheap single-bin DFT. */
function goertzel(samples: Float32Array, sampleRate: number, freq: number): number {
  const k = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

/** One frame's F0 via normalised autocorrelation. */
function frameF0(frame: Float32Array, sampleRate: number): number | null {
  const minLag = Math.floor(sampleRate / 240);
  const maxLag = Math.min(Math.floor(sampleRate / MIN_F0), Math.floor(frame.length / 2));
  if (maxLag <= minLag) return null;
  let bestLag = 0;
  let best = 0;
  let energy = 0;
  for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
  if (energy <= 0) return null;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < frame.length; i += 1) sum += frame[i] * frame[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  // Correlation has to be a real periodicity, not just "less bad than the rest".
  if (bestLag === 0 || best / energy < 0.25) return null;
  return sampleRate / bestLag;
}

/**
 * Measure one clip. Returns null when the bytes are not 16-bit PCM WAV — the
 * caller then records no acoustics at all.
 */
export function describeAcoustics(buffer: Buffer): AcousticSnapshot | null {
  const parsed = parseWav(buffer);
  if (!parsed) return null;
  const { pcm, sampleRate, channels } = parsed;
  const totalSamples = Math.floor(pcm.length / 2 / channels);
  if (totalSamples < 400) return null;

  // Mono mixdown, one pass (the door sends mono, but be safe).
  const mono = new Float32Array(totalSamples);
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < totalSamples; i += 1) {
    let acc = 0;
    for (let c = 0; c < channels; c += 1) {
      acc += pcm.readInt16LE((i * channels + c) * 2) / 32768;
    }
    const value = acc / channels;
    mono[i] = value;
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    sumSquares += value * value;
  }

  const frameSize = 1024;
  const maxFrames = 12;
  const hop = Math.max(frameSize, Math.floor((totalSamples - frameSize) / maxFrames) || frameSize);
  const f0s: number[] = [];
  const centroids: number[] = [];
  let analysed = 0;
  let voiced = 0;

  for (let start = 0; start + frameSize <= totalSamples && analysed < maxFrames; start += hop) {
    analysed += 1;
    const frame = mono.subarray(start, start + frameSize);
    let energy = 0;
    for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
    const rms = Math.sqrt(energy / frame.length);
    if (rms < MIN_RMS) continue;
    const f0 = frameF0(frame, sampleRate);
    if (f0 === null) continue;
    voiced += 1;
    f0s.push(f0);
    // Spectral centroid from 48 log-spaced bins between 100 Hz and 4 kHz.
    let weighted = 0;
    let total = 0;
    for (let b = 0; b < 48; b += 1) {
      const freq = 100 * Math.pow(4000 / 100, b / 47);
      const mag = goertzel(frame, sampleRate, freq);
      weighted += freq * mag;
      total += mag;
    }
    if (total > 0) centroids.push(weighted / total);
  }

  return {
    durationSec: Math.round((totalSamples / sampleRate) * 100) / 100,
    rmsDb: toDb(Math.sqrt(sumSquares / totalSamples)),
    peakDb: toDb(peak),
    f0Hz: median(f0s) === null ? null : Math.round(median(f0s) as number),
    voicing: analysed === 0 ? 0 : Math.round((voiced / analysed) * 100) / 100,
    centroidHz: median(centroids) === null ? 0 : Math.round(median(centroids) as number),
    frames: analysed,
    note: 'acoustic snapshot, not a voiceprint',
  };
}
