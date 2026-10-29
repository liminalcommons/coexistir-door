/**
 * acousticSnapshot — the measurements must be REAL, and must stay labelled as
 * measurements.
 *
 * A synthetic 220 Hz tone is generated here, so the expected F0 is known before
 * the code runs: if the autocorrelation drifts, the spec says so instead of a
 * number that "looks plausible". The label check is deliberate too — every row
 * carries `note: 'acoustic snapshot, not a voiceprint'`, because the whole point
 * of the module is that this is NOT voice identification.
 */
import { describeAcoustics } from '../acousticSnapshot';

/** 16-bit PCM mono WAV of a sine at `freq`, `seconds` long. */
function toneWav(freq: number, seconds: number, sampleRate = 16000, amplitude = 0.4): Buffer {
  const samples = Math.floor(sampleRate * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude;
    pcm.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe('describeAcoustics', () => {
  it('measures the F0 of a 220 Hz tone within a couple of Hz', () => {
    const snapshot = describeAcoustics(toneWav(220, 1.5));
    expect(snapshot).not.toBeNull();
    expect(snapshot?.durationSec).toBeCloseTo(1.5, 1);
    expect(snapshot?.f0Hz).toBeGreaterThan(215);
    expect(snapshot?.f0Hz).toBeLessThan(225);
  });

  it('measures a 120 Hz tone separately (the F0 is not a constant)', () => {
    const low = describeAcoustics(toneWav(120, 1.2));
    const high = describeAcoustics(toneWav(220, 1.2));
    expect(low?.f0Hz).toBeGreaterThan(115);
    expect(low?.f0Hz).toBeLessThan(125);
    expect(high?.f0Hz).toBeGreaterThan((low?.f0Hz ?? 0) + 50);
  });

  it('reports level in dBFS and a positive centroid', () => {
    const snapshot = describeAcoustics(toneWav(300, 1, 16000, 0.5));
    expect(snapshot?.rmsDb).toBeLessThan(0);
    expect(snapshot?.peakDb).toBeLessThanOrEqual(0);
    expect(snapshot?.centroidHz).toBeGreaterThan(100);
    expect(snapshot?.voicing).toBeGreaterThan(0.5);
    expect(snapshot?.frames).toBeGreaterThan(0);
  });

  it('labels itself as a snapshot, never a voiceprint', () => {
    const snapshot = describeAcoustics(toneWav(180, 1));
    expect(snapshot?.note).toBe('acoustic snapshot, not a voiceprint');
  });

  it('returns null for bytes that are not a WAV (no invented numbers)', () => {
    expect(describeAcoustics(Buffer.from('not-a-wav-file-at-all'))).toBeNull();
    expect(describeAcoustics(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for a clip too short to measure', () => {
    expect(describeAcoustics(toneWav(200, 0.005))).toBeNull();
  });

  it('reports no F0 for silence instead of a fabricated pitch', () => {
    const silent = toneWav(200, 1, 16000, 0);
    const snapshot = describeAcoustics(silent);
    // The WAV parses (it is real audio), but nothing is voiced.
    expect(snapshot).not.toBeNull();
    expect(snapshot?.f0Hz).toBeNull();
    expect(snapshot?.voicing).toBe(0);
  });
});
