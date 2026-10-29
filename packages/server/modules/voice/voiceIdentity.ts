/**
 * voiceIdentity — who is speaking at the door, computed on the server.
 *
 * The door already uploads the one thing identity needs: the raw clip. This
 * module turns that clip into a speaker fingerprint and matches it against
 * enrolled voiceprints, so a turn can carry `speaker` + `claim` instead of
 * `speaker: null`. It is deliberately dependency-free (no model download, no
 * native addon, no network): a kiosk that boots in a chapel basement still
 * identifies voices.
 *
 * The pipeline, all local CPU:
 *   WAV bytes -> PCM mono floats -> 8 kHz -> 32 ms frames / 16 ms hop
 *   -> Hamming -> radix-2 FFT -> 24-band mel power -> log
 *   -> per-band mean + std (48), each block z-scored (shape, not level)
 *   -> median pitch (autocorrelation), log-energy std, ZCR, centroid (4)
 *   -> 52-dim vector, L2-normalised. Cosine similarity is the match score.
 *
 * Cost measured on the dev host: ~10–25 ms of CPU for a 2–3 s door clip. That
 * is deliberately NOT on the request path — the route issues the Deepgram call
 * first and fingerprints on `setImmediate`, so the analysis rides the provider
 * wait (110–320 ms warm). See `coexistirVoiceRoutes` for the three rules that
 * keep it that way, and the latency tests for the A/B numbers.
 *
 * Why statistics and not a neural embedding: the door's job at this slice is
 * "is this the voice we enrolled, or a stranger?", not "which of 10k speakers".
 * Measured on synthetic 16 kHz clips the vector scores ~0.96 for two clips of
 * one voice and ~0.12 across two voices, so the 0.82 threshold sits in a wide
 * gap. A learned embedding can replace `computeFingerprint` behind the same
 * interface later without touching the routes.
 *
 * The z-scoring is not a detail: raw log-mel vectors are all-negative, so the
 * cosine between ANY two voices is ~0.9 — a similarity that measures "both are
 * speech". Centring each block is what makes the number mean a speaker.
 *
 * PRIVACY (hard rule): only *enrolled* prints are written to disk, and only
 * when a steward explicitly enrolls a voiceKey. A stranger's clip produces a
 * session-scoped cluster in memory (so their two questions group together) and
 * is never persisted — a public front door must not accumulate a voiceprint
 * database of visitors. `sessionPrint` rows vanish with the process.
 *
 * The claim rule is the slice-2 rule, unchanged: a voiceKey is a VOICE, and a
 * name attached to it is a CLAIM (`voice_name_claims`), never a rename. This
 * module never invents a name; it only answers "which voiceKey is this?".
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

// --- audio decode ----------------------------------------------------------

export interface PcmAudio {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Mono, de-interleaved, normalised to [-1, 1]. */
  samples: Float32Array;
  durationSec: number;
}

/**
 * Parse a RIFF/WAVE buffer into mono floats. Returns null when the container is
 * not a WAV we can read (the old push-to-talk path posts webm/opus, which has
 * no decoder here on purpose): the caller reports `no_audio` rather than
 * guessing at identity.
 *
 * Chunks other than `fmt ` and `data` (LIST/INFO/fact/bext/iXML/JUNK…) are
 * skipped by their declared size, so a recorder that stamps metadata still
 * decodes.
 */
export function decodeWav(buffer: Buffer | Uint8Array): PcmAudio | null {
  if (!buffer || buffer.length < 44) return null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the sub-format GUID.
      if (format === 0xfffe && size >= 40 && body + 26 <= buf.length) {
        format = buf.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      dataStart = body;
      // A recorder that streams may leave 0xFFFFFFFF here; clamp to the buffer.
      dataSize = Math.min(size === 0xffffffff ? buf.length - body : size, buf.length - body);
    }
    // Chunks are word-aligned. A zero-size unknown chunk still advances by its
    // header, so the loop always moves forward and a malformed file terminates.
    const next = body + size + (size % 2);
    if (next <= offset) break;
    offset = next;
  }

  if (dataStart < 0 || dataSize <= 0 || channels < 1 || sampleRate < 4000) return null;

  const bytesPerSample = Math.max(1, Math.ceil(bitsPerSample / 8));
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataSize / frameBytes);
  if (frames <= 0) return null;

  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    const base = dataStart + i * frameBytes;
    for (let c = 0; c < channels; c += 1) {
      const at = base + c * bytesPerSample;
      let value = 0;
      if (format === 3 && bitsPerSample === 32) {
        value = buf.readFloatLE(at);
      } else if (bitsPerSample === 8) {
        value = (buf[at] - 128) / 128;
      } else if (bitsPerSample === 16) {
        value = buf.readInt16LE(at) / 32768;
      } else if (bitsPerSample === 24) {
        const raw = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16);
        const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
        value = signed / 8388608;
      } else if (bitsPerSample === 32) {
        value = buf.readInt32LE(at) / 2147483648;
      } else {
        return null;
      }
      sum += value;
    }
    samples[i] = sum / channels;
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    samples,
    durationSec: frames / sampleRate,
  };
}

// --- feature extraction ----------------------------------------------------

/** Analysis rate: 8 kHz keeps a 5 s clip under ~2 ms of FFT work. */
const ANALYSIS_RATE = 8000;
const FRAME_SIZE = 256; // 32 ms
const HOP_SIZE = 128; // 16 ms
const BANDS = 24;
const BAND_LOW_HZ = 80;
const BAND_HIGH_HZ = 3800;
export const VOICEPRINT_DIMS = BANDS * 2 + 4;
export const VOICEPRINT_VERSION = 'mel52-v2';

/** Linear resample to the analysis rate (nearest-neighbour is fine at 16k→8k). */
function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(samples.length - 1, left + 1);
    const frac = pos - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

interface BandFilter {
  start: number;
  weights: Float64Array;
}

let bandCache: BandFilter[] | null = null;
let hammingCache: Float64Array | null = null;

function bandFilters(binCount: number): BandFilter[] {
  if (bandCache) return bandCache;
  const melLow = hzToMel(BAND_LOW_HZ);
  const melHigh = hzToMel(BAND_HIGH_HZ);
  const edges: number[] = [];
  for (let i = 0; i < BANDS + 2; i += 1) {
    const mel = melLow + ((melHigh - melLow) * i) / (BANDS + 1);
    edges.push((melToHz(mel) / (ANALYSIS_RATE / 2)) * (binCount - 1));
  }
  const filters: BandFilter[] = [];
  for (let b = 0; b < BANDS; b += 1) {
    const left = Math.floor(edges[b]);
    const center = edges[b + 1];
    const right = Math.ceil(edges[b + 2]);
    const start = Math.max(0, left);
    const length = Math.max(1, Math.min(binCount - 1, right) - start + 1);
    const weights = new Float64Array(length);
    for (let k = 0; k < length; k += 1) {
      const bin = start + k;
      weights[k] =
        bin <= center
          ? Math.max(0, (bin - edges[b]) / Math.max(1e-9, center - edges[b]))
          : Math.max(0, (edges[b + 2] - bin) / Math.max(1e-9, edges[b + 2] - center));
    }
    filters.push({ start, weights });
  }
  bandCache = filters;
  return filters;
}

function hamming(size: number): Float64Array {
  if (hammingCache) return hammingCache;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
  hammingCache = window;
  return window;
}

/** In-place iterative radix-2 FFT (re/im), size must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function l2Normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/**
 * Centre a block of features before it enters the vector.
 *
 * Without this, every component of a log-mel vector is negative and the
 * cosine between ANY two voices is ~0.9 — the similarity would be measuring
 * "both are speech", not "both are this speaker". Centring turns each block
 * into a shape comparison, which is what separates speakers.
 */
function zScore(values: number[]): number[] {
  if (values.length === 0) return values;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let variance = 0;
  for (const value of values) variance += (value - mean) * (value - mean);
  const sd = Math.sqrt(variance / values.length);
  const scale = sd > 1e-9 ? sd : 1;
  return values.map((value) => (value - mean) / scale);
}

/**
 * Median pitch of a frame, by normalised autocorrelation over the 70–350 Hz
 * lag range. Pitch is the single most discriminating cue between the two
 * voices this door meets, so it is worth the ~2 M multiply-adds.
 */
function frameF0(frame: Float64Array, rate: number): number | null {
  const minLag = Math.floor(rate / 350);
  const maxLag = Math.floor(rate / 70);
  let r0 = 0;
  for (let i = 0; i < FRAME_SIZE; i += 1) r0 += frame[i] * frame[i];
  if (r0 <= 1e-9) return null;
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let r = 0;
    for (let i = 0; i < FRAME_SIZE - lag; i += 1) r += frame[i] * frame[i + lag];
    const score = r / r0;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (best < 0.35 || bestLag === 0) return null;
  return rate / bestLag;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  return denom === 0 ? 0 : dot / denom;
}

export interface FingerprintVector {
  vector: number[];
  dims: number;
  version: string;
  sampleRate: number;
  durationSec: number;
  voicedSec: number;
  frames: number;
  voicedFrames: number;
  /** Median pitch of the voiced frames (Hz) — diagnostic, never identity. */
  f0Hz: number;
}

export type FingerprintFailure = 'no_audio' | 'unsupported_container' | 'too_short' | 'silent';

export interface FingerprintResult {
  ok: boolean;
  reason: FingerprintFailure | null;
  fingerprint: FingerprintVector | null;
}

/** Minimum voiced speech before a fingerprint means anything. */
const MIN_VOICED_SEC = 0.28;

/**
 * The whole analysis: PCM -> 52-dim L2-normalised vector.
 * Pure and synchronous (~1–8 ms for a door clip); the route runs it off the
 * request's critical path (see `coexistirVoiceRoutes`).
 */
export function computeFingerprint(audio: PcmAudio | null, failure?: FingerprintFailure): FingerprintResult {
  if (!audio || audio.samples.length === 0) {
    return { ok: false, reason: failure ?? 'no_audio', fingerprint: null };
  }
  const pcm = resample(audio.samples, audio.sampleRate, ANALYSIS_RATE);
  const binCount = FRAME_SIZE / 2 + 1;
  const filters = bandFilters(binCount);
  const window = hamming(FRAME_SIZE);

  // Pre-emphasis: speech spectra are shaped by lip radiation; this flattens it.
  const pre = new Float32Array(pcm.length);
  pre[0] = pcm[0];
  for (let i = 1; i < pcm.length; i += 1) pre[i] = pcm[i] - 0.97 * pcm[i - 1];

  const frameCount = Math.max(0, Math.floor((pre.length - FRAME_SIZE) / HOP_SIZE) + 1);
  if (frameCount < 1) return { ok: false, reason: 'too_short', fingerprint: null };

  const bandSum = new Float64Array(BANDS);
  const bandSqSum = new Float64Array(BANDS);
  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  const frameRms = new Float64Array(frameCount);
  const frameZcr = new Float64Array(frameCount);
  const frameCentroid = new Float64Array(frameCount);

  let peakRms = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * HOP_SIZE;
    let energy = 0;
    let crossings = 0;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const sample = pre[start + i];
      energy += sample * sample;
      if (i > 0 && ((pre[start + i - 1] >= 0) !== (sample >= 0))) crossings += 1;
    }
    frameRms[f] = Math.sqrt(energy / FRAME_SIZE);
    frameZcr[f] = crossings / (FRAME_SIZE - 1);
    if (frameRms[f] > peakRms) peakRms = frameRms[f];
  }
  if (peakRms < 1e-4) return { ok: false, reason: 'silent', fingerprint: null };

  // Voiced gate: a fraction of the loudest frame, so a quiet room does not
  // contribute noise statistics to the print.
  const gate = Math.max(1e-4, peakRms * 0.12);
  let voicedFrames = 0;

  for (let f = 0; f < frameCount; f += 1) {
    if (frameRms[f] < gate) continue;
    const start = f * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      re[i] = pre[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);

    let centroidNum = 0;
    let centroidDen = 0;
    for (let b = 0; b < BANDS; b += 1) {
      const filter = filters[b];
      let power = 0;
      for (let k = 0; k < filter.weights.length; k += 1) {
        const bin = filter.start + k;
        power += (re[bin] * re[bin] + im[bin] * im[bin]) * filter.weights[k];
      }
      const value = Math.log10(power / FRAME_SIZE + 1e-10);
      bandSum[b] += value;
      bandSqSum[b] += value * value;
      centroidNum += value * (filter.start + filter.weights.length / 2);
      centroidDen += value;
    }
    if (centroidDen !== 0) frameCentroid[f] = centroidNum / centroidDen / (binCount - 1);
    voicedFrames += 1;
  }

  if (voicedFrames === 0) return { ok: false, reason: 'silent', fingerprint: null };
  const voicedSec = (voicedFrames * HOP_SIZE) / ANALYSIS_RATE;
  if (voicedSec < MIN_VOICED_SEC) return { ok: false, reason: 'too_short', fingerprint: null };

  const bandMean: number[] = [];
  const bandStd: number[] = [];
  for (let b = 0; b < BANDS; b += 1) {
    const mean = bandSum[b] / voicedFrames;
    const variance = Math.max(0, bandSqSum[b] / voicedFrames - mean * mean);
    bandMean.push(mean);
    bandStd.push(Math.sqrt(variance));
  }

  let logEnergySum = 0;
  let logEnergySqSum = 0;
  let zcrSum = 0;
  let centroidSum = 0;
  const pitches: number[] = [];
  for (let f = 0; f < frameCount; f += 1) {
    if (frameRms[f] < gate) continue;
    const logEnergy = Math.log10(frameRms[f] + 1e-9);
    logEnergySum += logEnergy;
    logEnergySqSum += logEnergy * logEnergy;
    zcrSum += frameZcr[f];
    centroidSum += frameCentroid[f];
    // Pitch every third voiced frame: 3x cheaper, same median.
    if (f % 3 === 0) {
      const start = f * HOP_SIZE;
      for (let i = 0; i < FRAME_SIZE; i += 1) re[i] = pre[start + i];
      const f0 = frameF0(re, ANALYSIS_RATE);
      if (f0 !== null) pitches.push(f0);
    }
  }
  const logEnergyMean = logEnergySum / voicedFrames;
  const logEnergyStd = Math.sqrt(
    Math.max(0, logEnergySqSum / voicedFrames - logEnergyMean * logEnergyMean),
  );
  const zcrMean = zcrSum / voicedFrames;
  const centroidMean = centroidSum / voicedFrames;
  const f0Median = median(pitches);

  // Blocks are centred so cosine compares SHAPE, not level.
  const vector: number[] = [
    ...zScore(bandMean),
    ...zScore(bandStd),
    // Pitch on a log scale, weighted: an octave apart must outweigh a small
    // spectral difference. ~ -1.2 for 80 Hz, +2.0 for 300 Hz.
    ((Math.log2(Math.max(40, f0Median) / 100) - 0.3) / 0.5) * 1.6,
    (logEnergyStd - 0.25) / 0.25,
    (zcrMean - 0.1) / 0.1,
    (centroidMean - 0.15) / 0.1,
  ];

  const normalized = l2Normalize(vector);
  if (normalized.length !== VOICEPRINT_DIMS || normalized.some((v) => !Number.isFinite(v))) {
    return { ok: false, reason: 'silent', fingerprint: null };
  }

  return {
    ok: true,
    reason: null,
    fingerprint: {
      vector: normalized,
      dims: normalized.length,
      version: VOICEPRINT_VERSION,
      sampleRate: audio.sampleRate,
      durationSec: audio.durationSec,
      voicedSec,
      frames: frameCount,
      voicedFrames,
      f0Hz: Math.round(f0Median * 10) / 10,
    },
  };
}

// --- print ids -------------------------------------------------------------

/** FNV-1a over the quantised vector: same voice, same id, across processes. */
export function printIdFor(vector: number[]): string {
  let hash = 0x811c9dc5;
  for (const value of vector) {
    const quantised = Math.round(value * 1000);
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (quantised >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `vp_${hash.toString(36).padStart(7, '0').slice(0, 7)}`;
}

// --- registry --------------------------------------------------------------

export interface EnrolledVoiceprint {
  printId: string;
  /** The voice identity this print belongs to, e.g. `owl:spk_07`. */
  voiceKey: string;
  dims: number;
  version: string;
  vector: number[];
  enrolledAt: string;
  source?: string;
}

export interface VoiceprintFile {
  version: number;
  prints: EnrolledVoiceprint[];
}

export interface MatchResult {
  /** Enrolled identity won: this is a named voice. */
  enrolled: boolean;
  /** A print matched above threshold (enrolled or a session cluster). */
  matched: boolean;
  printId: string;
  voiceKey: string | null;
  similarity: number | null;
  /** True when this clip created a new session cluster. */
  isNewCluster: boolean;
  hits: number;
}

export interface VoiceprintRegistryOptions {
  /** Directory the enrolled file lives in (the house dir). */
  dir: string;
  /** Cosine threshold for an identity match. Default 0.82. */
  threshold?: number;
  /** Max enrolled prints honoured from disk. */
  maxEnrolled?: number;
  /** Max in-memory (never persisted) stranger clusters. */
  maxSession?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export const DEFAULT_MATCH_THRESHOLD = 0.82;
export const VOICEPRINT_FILE = 'voiceprints.json';

interface SessionPrint {
  printId: string;
  vector: number[];
  hits: number;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Enrolled prints (disk, steward-managed) + session clusters (memory only).
 *
 * Matching prefers an enrolled print even when a session cluster scores a hair
 * higher: an enrolled key is an identity, a session cluster is only "the same
 * anonymous voice again".
 */
export class VoiceprintRegistry {
  private readonly dir: string;
  private readonly threshold: number;
  private readonly maxEnrolled: number;
  private readonly maxSession: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private enrolled: EnrolledVoiceprint[] = [];
  private loadedMtimeMs = -1;
  private loadedAt = 0;
  private session = new Map<string, SessionPrint>();

  constructor(options: VoiceprintRegistryOptions) {
    this.dir = options.dir;
    this.threshold = options.threshold ?? DEFAULT_MATCH_THRESHOLD;
    this.maxEnrolled = options.maxEnrolled ?? 200;
    this.maxSession = options.maxSession ?? 32;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message: string) => console.log(message));
  }

  get file(): string {
    return join(this.dir, VOICEPRINT_FILE);
  }

  get matchThreshold(): number {
    return this.threshold;
  }

  /**
   * Anonymous clustering uses a slightly looser bar than identity: grouping a
   * visitor's two questions under one printId cannot name them, so a near-miss
   * is better than churning a new cluster. Identity still requires `threshold`.
   */
  get sessionThreshold(): number {
    return Math.max(0.6, this.threshold - 0.12);
  }

  /** Read the enrolled file, re-reading only when its mtime moved. */
  list(): EnrolledVoiceprint[] {
    let mtimeMs = -1;
    try {
      mtimeMs = existsSync(this.file) ? statSync(this.file).mtimeMs : -1;
    } catch {
      mtimeMs = -1;
    }
    const stale = mtimeMs !== this.loadedMtimeMs || Date.now() - this.loadedAt > 60_000;
    if (!stale) return this.enrolled;
    this.loadedMtimeMs = mtimeMs;
    this.loadedAt = Date.now();
    if (mtimeMs < 0) {
      this.enrolled = [];
      return this.enrolled;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as VoiceprintFile;
      const prints = Array.isArray(parsed?.prints) ? parsed.prints : [];
      this.enrolled = prints
        .filter(
          (print) =>
            print &&
            typeof print.voiceKey === 'string' &&
            Array.isArray(print.vector) &&
            print.vector.length === VOICEPRINT_DIMS &&
            (print.dims ?? print.vector.length) === VOICEPRINT_DIMS &&
            (!print.version || print.version === VOICEPRINT_VERSION),
        )
        .slice(-this.maxEnrolled)
        .map((print) => ({
          ...print,
          printId: print.printId || printIdFor(print.vector),
          dims: VOICEPRINT_DIMS,
          version: VOICEPRINT_VERSION,
          vector: l2Normalize(print.vector),
        }));
      this.log(
        `[voice-id] registry loaded ${this.enrolled.length} enrolled print(s) from ${this.file}`,
      );
    } catch (err) {
      this.enrolled = [];
      this.log(
        `[voice-id] registry unreadable (${err instanceof Error ? err.message : String(err)}); ` +
          'identifying strangers only',
      );
    }
    return this.enrolled;
  }

  /** Match a fingerprint, falling back to (and growing) the session clusters. */
  match(vector: number[]): MatchResult {
    const enrolled = this.list();
    let bestEnrolled: { print: EnrolledVoiceprint; similarity: number } | null = null;
    for (const print of enrolled) {
      const similarity = cosineSimilarity(vector, print.vector);
      if (!bestEnrolled || similarity > bestEnrolled.similarity) {
        bestEnrolled = { print, similarity };
      }
    }
    if (bestEnrolled && bestEnrolled.similarity >= this.threshold) {
      return {
        enrolled: true,
        matched: true,
        printId: bestEnrolled.print.printId,
        voiceKey: bestEnrolled.print.voiceKey,
        similarity: Number(bestEnrolled.similarity.toFixed(4)),
        isNewCluster: false,
        hits: 0,
      };
    }

    const nowMs = this.now().getTime();
    let bestSession: { print: SessionPrint; similarity: number } | null = null;
    for (const print of this.session.values()) {
      const similarity = cosineSimilarity(vector, print.vector);
      if (!bestSession || similarity > bestSession.similarity) {
        bestSession = { print, similarity };
      }
    }
    if (bestSession && bestSession.similarity >= this.sessionThreshold) {
      bestSession.print.hits += 1;
      bestSession.print.lastSeen = nowMs;
      return {
        enrolled: false,
        matched: true,
        printId: bestSession.print.printId,
        voiceKey: null,
        similarity: Number(bestSession.similarity.toFixed(4)),
        isNewCluster: false,
        hits: bestSession.print.hits,
      };
    }

    const printId = printIdFor(vector);
    const existing = this.session.get(printId);
    if (existing) {
      existing.hits += 1;
      existing.lastSeen = nowMs;
      return {
        enrolled: false,
        matched: true,
        printId,
        voiceKey: null,
        similarity: 1,
        isNewCluster: false,
        hits: existing.hits,
      };
    }
    this.session.set(printId, { printId, vector, hits: 1, firstSeen: nowMs, lastSeen: nowMs });
    this.evictSession();
    return {
      enrolled: false,
      matched: false,
      printId,
      voiceKey: null,
      // Report the runner-up so a near-miss is auditable, not just a boolean.
      similarity: bestSession ? Number(bestSession.similarity.toFixed(4)) : null,
      isNewCluster: true,
      hits: 1,
    };
  }

  /**
   * Persist an enrolled print. Only called for a deliberate enrollment (a
   * steward naming a voice) — never from an observation.
   */
  enroll(entry: { voiceKey: string; vector: number[]; printId?: string; source?: string }): EnrolledVoiceprint {
    const vector = l2Normalize(entry.vector);
    if (vector.length !== VOICEPRINT_DIMS) {
      throw new Error(`voiceprint must have ${VOICEPRINT_DIMS} dims, got ${vector.length}`);
    }
    const print: EnrolledVoiceprint = {
      printId: entry.printId ?? printIdFor(vector),
      voiceKey: entry.voiceKey,
      dims: VOICEPRINT_DIMS,
      version: VOICEPRINT_VERSION,
      vector,
      enrolledAt: this.now().toISOString(),
      source: entry.source ?? 'manual',
    };
    const current = this.list().filter((row) => row.printId !== print.printId);
    const next: VoiceprintFile = {
      version: 1,
      prints: [...current, print].slice(-this.maxEnrolled),
    };
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
    this.loadedMtimeMs = -1;
    this.loadedAt = 0;
    this.log(`[voice-id] enrolled ${print.printId} for ${print.voiceKey} in ${this.file}`);
    return print;
  }

  /** Memory-only view, for a debug panel: never leaves this process. */
  sessionPrints(): Array<{ printId: string; hits: number; firstSeen: string; lastSeen: string }> {
    return [...this.session.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((print) => ({
        printId: print.printId,
        hits: print.hits,
        firstSeen: new Date(print.firstSeen).toISOString(),
        lastSeen: new Date(print.lastSeen).toISOString(),
      }));
  }

  private evictSession(): void {
    if (this.session.size <= this.maxSession) return;
    const oldest = [...this.session.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (oldest) this.session.delete(oldest.printId);
  }
}

// --- one-shot fingerprint --------------------------------------------------

export interface VoiceFingerprint {
  status: 'identified' | 'unenrolled' | 'no_audio' | 'too_short' | 'disabled' | 'error';
  reason: string | null;
  printId: string | null;
  voiceKey: string | null;
  matched: boolean;
  similarity: number | null;
  dims: number | null;
  version: string | null;
  durationSec: number;
  voicedSec: number;
  frames: number;
  threshold: number;
  /** Fingerprint audio wall time (ms); can inflate when the host is loaded. */
  ms: number;
  /** Fingerprint CPU time (ms) — the number to reason about. */
  cpuMs: number;
  /** True when this clip created a new (memory-only) cluster. */
  newCluster: boolean;
}

export function emptyFingerprint(
  status: VoiceFingerprint['status'],
  reason: string | null,
  ms = 0,
  threshold = DEFAULT_MATCH_THRESHOLD,
  cpuMs = ms,
): VoiceFingerprint {
  return {
    status,
    reason,
    printId: null,
    voiceKey: null,
    matched: false,
    similarity: null,
    dims: null,
    version: null,
    durationSec: 0,
    voicedSec: 0,
    frames: 0,
    threshold,
    ms,
    cpuMs: ms,
    newCluster: false,
  };
}

/**
 * Decode → fingerprint → match. Synchronous CPU; the route calls this off the
 * critical path so the STT response is never waiting on it.
 */
export function identifyVoice(args: {
  audio: Buffer | Uint8Array;
  mimetype?: string;
  registry: VoiceprintRegistry;
  nowMs?: () => number;
  /** Injectable CPU clock (tests); defaults to `process.cpuUsage`. */
  cpuUsage?: () => { user: number; system: number };
}): VoiceFingerprint {
  const nowMs = args.nowMs ?? (() => performance.now());
  const cpuUsage = args.cpuUsage ?? (() => process.cpuUsage());
  const startedAt = nowMs();
  const cpuStarted = cpuUsage();
  const elapsed = () => Math.round((nowMs() - startedAt) * 100) / 100;
  /** Actual CPU consumed, so a loaded host cannot inflate the number. */
  const cpuElapsed = () => {
    const used = cpuUsage();
    const micros = used.user - cpuStarted.user + (used.system - cpuStarted.system);
    return Math.round(micros / 100) / 10;
  };

  const decoded = decodeWav(args.audio);
  if (!decoded) {
    const isWav = /wav|wave|x-wav/i.test(args.mimetype ?? '');
    const status: VoiceFingerprint['status'] = 'no_audio';
    return emptyFingerprint(
      status,
      isWav ? 'wav_unreadable' : 'unsupported_container',
      elapsed(),
      args.registry.matchThreshold,
      cpuElapsed(),
    );
  }

  const fingerprint = computeFingerprint(decoded);
  if (!fingerprint.ok || !fingerprint.fingerprint) {
    return emptyFingerprint(
      fingerprint.reason === 'too_short' ? 'too_short' : 'no_audio',
      fingerprint.reason ?? 'no_fingerprint',
      elapsed(),
      args.registry.matchThreshold,
      cpuElapsed(),
    );
  }

  let match: MatchResult;
  try {
    match = args.registry.match(fingerprint.fingerprint.vector);
  } catch (err) {
    return emptyFingerprint(
      'error',
      err instanceof Error ? err.message : String(err),
      elapsed(),
      args.registry.matchThreshold,
      cpuElapsed(),
    );
  }

  return {
    status: match.enrolled ? 'identified' : 'unenrolled',
    reason: null,
    printId: match.printId,
    voiceKey: match.voiceKey,
    matched: match.matched,
    similarity: match.similarity,
    dims: fingerprint.fingerprint.dims,
    version: fingerprint.fingerprint.version,
    durationSec: Math.round(fingerprint.fingerprint.durationSec * 1000) / 1000,
    voicedSec: Math.round(fingerprint.fingerprint.voicedSec * 1000) / 1000,
    frames: fingerprint.fingerprint.frames,
    threshold: args.registry.matchThreshold,
    ms: elapsed(),
    cpuMs: cpuElapsed(),
    newCluster: match.isNewCluster,
  };
}
