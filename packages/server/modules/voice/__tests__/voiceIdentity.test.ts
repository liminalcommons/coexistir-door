/**
 * voiceIdentity.test.ts — the server-side ear, proven on synthetic WAVs.
 *
 * What must hold:
 * - a 16 kHz mono PCM WAV (exactly what the door's VAD posts) decodes, and a
 *   webm/opus body is refused instead of guessed at;
 * - the same clip fingerprints identically twice, and two clips of the same
 *   synthetic voice score far above two different voices;
 * - an enrolled print yields `identified` + the enrolled voiceKey, a stranger
 *   yields `unenrolled` with a printId and no key;
 * - a stranger's second clip re-uses the same session cluster — in memory only.
 *   Enrollment is the ONLY path that writes a file (public door, no visitor DB).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_MATCH_THRESHOLD,
  VOICEPRINT_DIMS,
  VOICEPRINT_FILE,
  VoiceprintRegistry,
  computeFingerprint,
  cosineSimilarity,
  decodeWav,
  identifyVoice,
  printIdFor,
} from '../voiceIdentity';
import { VOICE_A, VOICE_A_AGAIN, VOICE_B, synthVoice, voiceWav, wavFromSamples } from './wavFixture';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-id-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registry(threshold = DEFAULT_MATCH_THRESHOLD): VoiceprintRegistry {
  return new VoiceprintRegistry({ dir, threshold, log: () => undefined });
}

function vectorFor(spec: typeof VOICE_A): number[] {
  const decoded = decodeWav(voiceWav(spec));
  expect(decoded).not.toBeNull();
  const result = computeFingerprint(decoded);
  expect(result.ok).toBe(true);
  return result.fingerprint!.vector;
}

describe('decodeWav', () => {
  it('reads a 16 kHz mono PCM WAV the door produced', () => {
    const wav = voiceWav({ ...VOICE_A, durationSec: 1.5 });
    const decoded = decodeWav(wav);
    expect(decoded).not.toBeNull();
    expect(decoded!.sampleRate).toBe(16_000);
    expect(decoded!.channels).toBe(1);
    expect(decoded!.bitsPerSample).toBe(16);
    expect(decoded!.durationSec).toBeCloseTo(1.5, 2);
    expect(decoded!.samples.length).toBe(24_000);
  });

  it('refuses a container it cannot decode (the old webm path)', () => {
    const webm = Buffer.alloc(4096, 7);
    expect(decodeWav(webm)).toBeNull();
    const identified = identifyVoice({ audio: webm, mimetype: 'audio/webm', registry: registry() });
    expect(identified.status).toBe('no_audio');
    expect(identified.reason).toBe('unsupported_container');
    expect(identified.voiceKey).toBeNull();
  });

  it('reads 8-bit and stereo WAVs without inventing samples', () => {
    const samples = synthVoice({ ...VOICE_A, durationSec: 0.8 });
    const mono8 = Buffer.alloc(44 + samples.length);
    const header = wavFromSamples(new Float32Array(0), 16_000);
    header.copy(mono8, 0);
    mono8.writeUInt16LE(8, 34);
    mono8.writeUInt32LE(samples.length, 40);
    for (let i = 0; i < samples.length; i += 1) {
      mono8[44 + i] = Math.round((samples[i] + 1) * 127.5);
    }
    const decoded8 = decodeWav(mono8);
    expect(decoded8?.bitsPerSample).toBe(8);
    expect(decoded8!.samples.length).toBe(samples.length);
  });
});

describe('computeFingerprint', () => {
  it('is deterministic and 52-dim normalised', () => {
    const wav = voiceWav(VOICE_A);
    const first = computeFingerprint(decodeWav(wav));
    const second = computeFingerprint(decodeWav(wav));
    expect(first.ok).toBe(true);
    expect(first.fingerprint!.dims).toBe(VOICEPRINT_DIMS);
    expect(first.fingerprint!.vector).toEqual(second.fingerprint!.vector);
    const norm = Math.sqrt(first.fingerprint!.vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('separates speakers far more than it separates clips of one speaker', () => {
    const a = vectorFor(VOICE_A);
    const aAgain = vectorFor(VOICE_A_AGAIN);
    const b = vectorFor(VOICE_B);
    const same = cosineSimilarity(a, aAgain);
    const different = cosineSimilarity(a, b);
    // The margin is the point: a threshold has to sit between these.
    console.log(`[voice-id] same-speaker=${same.toFixed(3)} cross-speaker=${different.toFixed(3)}`);
    expect(same).toBeGreaterThan(0.9);
    expect(different).toBeLessThan(0.7);
    expect(same - different).toBeGreaterThan(0.25);
  });

  it('estimates a stable pitch for each synthetic voice', () => {
    const a = computeFingerprint(decodeWav(voiceWav(VOICE_A)));
    const b = computeFingerprint(decodeWav(voiceWav(VOICE_B)));
    console.log(`[voice-id] f0 A=${a.fingerprint!.f0Hz}Hz B=${b.fingerprint!.f0Hz}Hz`);
    expect(a.fingerprint!.f0Hz).toBeGreaterThan(100);
    expect(a.fingerprint!.f0Hz).toBeLessThan(130);
    expect(b.fingerprint!.f0Hz).toBeGreaterThan(190);
    expect(b.fingerprint!.f0Hz).toBeLessThan(240);
  });

  it('reports a clip that is too short to fingerprint instead of guessing', () => {
    const wav = voiceWav({ ...VOICE_A, durationSec: 0.1 });
    const identified = identifyVoice({ audio: wav, mimetype: 'audio/wav', registry: registry() });
    expect(identified.status).toBe('too_short');
    expect(identified.voiceKey).toBeNull();
    expect(identified.printId).toBeNull();
  });

  it('reports silence as no audio, not as a voice', () => {
    const silence = wavFromSamples(new Float32Array(16_000), 16_000);
    const identified = identifyVoice({ audio: silence, mimetype: 'audio/wav', registry: registry() });
    expect(identified.status).toBe('no_audio');
    expect(identified.reason).toBe('silent');
  });
});

describe('VoiceprintRegistry', () => {
  it('identifies an enrolled voice and names the same printId on a new clip', () => {
    const reg = registry();
    reg.enroll({ voiceKey: 'owl:spk_07', vector: vectorFor(VOICE_A), source: 'test' });

    const first = identifyVoice({ audio: voiceWav(VOICE_A), mimetype: 'audio/wav', registry: reg });
    expect(first.status).toBe('identified');
    expect(first.voiceKey).toBe('owl:spk_07');
    expect(first.matched).toBe(true);
    expect(first.similarity).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);

    const second = identifyVoice({
      audio: voiceWav(VOICE_A_AGAIN),
      mimetype: 'audio/wav',
      registry: reg,
    });
    expect(second.status).toBe('identified');
    expect(second.voiceKey).toBe('owl:spk_07');
  });

  it('leaves a stranger unenrolled, and clusters their second clip without a name', () => {
    const reg = registry();
    reg.enroll({ voiceKey: 'owl:spk_07', vector: vectorFor(VOICE_A), source: 'test' });

    const first = identifyVoice({ audio: voiceWav(VOICE_B), mimetype: 'audio/wav', registry: reg });
    expect(first.status).toBe('unenrolled');
    expect(first.matched).toBe(false);
    expect(first.voiceKey).toBeNull();
    expect(first.printId).toMatch(/^vp_/);
    expect(first.newCluster).toBe(true);

    const again = identifyVoice({
      audio: voiceWav({ ...VOICE_B, seed: 555 }),
      mimetype: 'audio/wav',
      registry: reg,
    });
    expect(again.status).toBe('unenrolled');
    expect(again.voiceKey).toBeNull();
    expect(again.printId).toBe(first.printId);
    expect(again.newCluster).toBe(false);
  });

  it('keeps strangers out of the file — only enrollment writes a voiceprint', () => {
    const reg = registry();
    identifyVoice({ audio: voiceWav(VOICE_B), mimetype: 'audio/wav', registry: reg });
    identifyVoice({ audio: voiceWav(VOICE_A), mimetype: 'audio/wav', registry: reg });
    expect(existsSync(join(dir, VOICEPRINT_FILE))).toBe(false);

    reg.enroll({ voiceKey: 'owl:spk_07', vector: vectorFor(VOICE_A) });
    const file = JSON.parse(readFileSync(join(dir, VOICEPRINT_FILE), 'utf8')) as {
      prints: Array<{ voiceKey: string; dims: number }>;
    };
    expect(file.prints).toHaveLength(1);
    expect(file.prints[0].voiceKey).toBe('owl:spk_07');
    expect(file.prints[0].dims).toBe(VOICEPRINT_DIMS);
  });

  it('reloads an enrolled print from disk on a new process (same id)', () => {
    registry().enroll({ voiceKey: 'owl:spk_07', vector: vectorFor(VOICE_A) });
    const fresh = registry();
    const identified = identifyVoice({ audio: voiceWav(VOICE_A_AGAIN), mimetype: 'audio/wav', registry: fresh });
    expect(identified.status).toBe('identified');
    expect(identified.voiceKey).toBe('owl:spk_07');
  });

  it('ignores a malformed registry file instead of crashing the ear', () => {
    writeFileSync(join(dir, VOICEPRINT_FILE), '{not json', 'utf8');
    const reg = registry();
    const identified = identifyVoice({ audio: voiceWav(VOICE_A), mimetype: 'audio/wav', registry: reg });
    expect(identified.status).toBe('unenrolled');
  });

  it('printIdFor is stable for the same vector', () => {
    const vector = vectorFor(VOICE_A);
    expect(printIdFor(vector)).toBe(printIdFor(vector.slice()));
    expect(printIdFor(vector)).toMatch(/^vp_[0-9a-z]{7}$/);
  });
});
