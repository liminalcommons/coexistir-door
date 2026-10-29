/**
 * portalVad.test.ts — the always-on ear, without a microphone.
 *
 * The rig proves the door end-to-end; these tests pin the rules the owner
 * locked, frame by frame:
 *   - speech opens an utterance and KEEPS the pre-roll (no clipped first word);
 *   - ~1.2 s of silence closes it, and the clip does not carry the whole pause;
 *   - a cough is dropped instead of being paid for;
 *   - the detector never closes the session after a turn: a second utterance
 *     works with no restart (the always-on contract);
 *   - speaking over her is reported as a barge-in, at a higher bar;
 *   - the WAV is real 16 kHz mono 16-bit PCM with a correct header.
 */
import { VadCore, VAD_DEFAULTS, VAD_TAP_SOURCE, BlockLedger, encodeWav } from '../portalVad';

const RATE = 48000;
const FRAME = VAD_DEFAULTS.frameSize; // 2048 samples
const FRAME_MS = (FRAME / RATE) * 1000; // ≈ 42.67 ms

/** A frame of speech: a loud 220 Hz tone (RMS ≈ 0.14). */
function speechFrame(phase = 0): Float32Array {
  const data = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) data[i] = 0.2 * Math.sin((2 * Math.PI * 220 * (i + phase)) / RATE);
  return data;
}

/** A quiet room: RMS ≈ 0.001, well under every bar. */
function quietFrame(): Float32Array {
  const data = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) data[i] = 0.001 * Math.sin((2 * Math.PI * 90 * i) / RATE);
  return data;
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

describe('VadCore', () => {
  it('opens on speech, keeps pre-roll, and sends after ~1.2 s of silence', () => {
    const core = new VadCore({}, RATE);
    let t = 0;
    const events: ReturnType<VadCore['push']> = [];

    // 1 s of room tone first, so the floor is measured before the voice.
    for (let i = 0; i < 24; i += 1) {
      events.push(...core.push(quietFrame(), t));
      t += FRAME_MS;
    }
    expect(events.filter((e) => e.type === 'onset')).toHaveLength(0);

    // 1.5 s of speech.
    const speechStart = t;
    for (let i = 0; i < 35; i += 1) {
      events.push(...core.push(speechFrame(i), t));
      t += FRAME_MS;
    }
    const onsets = events.filter((e) => e.type === 'onset');
    expect(onsets).toHaveLength(1);
    expect(onsets[0]).toMatchObject({ type: 'onset', bargeIn: false });
    // The onset must be detected within ~2 frames of the first loud frame.
    expect(onsets[0].tMs - speechStart).toBeLessThanOrEqual(FRAME_MS * 2 + 1);

    // Silence: nothing is emitted before the 1.2 s bar…
    let utterance = null as null | Extract<ReturnType<VadCore['push']>[number], { type: 'utterance' }>;
    for (let i = 0; i < 34; i += 1) {
      const batch = core.push(quietFrame(), t);
      const found = batch.find((e) => e.type === 'utterance');
      if (found && found.type === 'utterance') {
        utterance = found;
        break;
      }
      t += FRAME_MS;
    }
    if (!utterance) throw new Error('the VAD never closed the utterance');
    // …and it fires at ~1.2 s, not at 2 s: 1200/42.67 ≈ 28 frames.
    expect(t - (speechStart + 35 * FRAME_MS)).toBeGreaterThanOrEqual(1150);
    expect(t - (speechStart + 35 * FRAME_MS)).toBeLessThanOrEqual(1320);
    expect(utterance.utterance.reason).toBe('silence');
    // Pre-roll: the clip is longer than the speech itself (it reaches back).
    expect(utterance.utterance.totalMs).toBeGreaterThan(utterance.utterance.speechMs);
    expect(utterance.utterance.speechMs).toBeGreaterThan(1200);
    expect(core.stats.sent).toBe(1);
  });

  it('stays listening after a turn: a second utterance needs no restart', () => {
    const core = new VadCore({}, RATE);
    let t = 0;
    const send = (count: number, frame: () => Float32Array) => {
      for (let i = 0; i < count; i += 1) core.push(frame(), t), (t += FRAME_MS);
    };
    const flush = () => {
      // Push silence until an utterance slips out.
      for (let i = 0; i < 40; i += 1) {
        const batch = core.push(quietFrame(), t);
        t += FRAME_MS;
        if (batch.some((e) => e.type === 'utterance')) return true;
      }
      return false;
    };

    send(20, quietFrame);
    send(30, () => speechFrame(1));
    expect(flush()).toBe(true);
    // The ear is still open — no stop() was needed, no state was reset.
    expect(core.stats.sent).toBe(1);
    expect(core.isCapturing).toBe(false);

    send(10, quietFrame);
    send(30, () => speechFrame(2));
    expect(flush()).toBe(true);
    expect(core.stats.sent).toBe(2);
    expect(core.stats.onsets).toBe(2);
  });

  it('drops a cough (too short) without inventing a turn', () => {
    const core = new VadCore({}, RATE);
    let t = 0;
    for (let i = 0; i < 20; i += 1) core.push(quietFrame(), t), (t += FRAME_MS);
    // 3 frames ≈ 128 ms of noise: under the 350 ms word minimum.
    for (let i = 0; i < 3; i += 1) core.push(speechFrame(i), t), (t += FRAME_MS);
    let discarded = 0;
    for (let i = 0; i < 40; i += 1) {
      const batch = core.push(quietFrame(), t);
      t += FRAME_MS;
      if (batch.some((e) => e.type === 'discard')) discarded += 1;
      if (batch.some((e) => e.type === 'utterance')) throw new Error('a cough must not be sent');
    }
    expect(discarded).toBe(1);
    expect(core.stats.sent).toBe(0);
  });

  it('drops a rattle that is long but never sustained (a click is not a word)', () => {
    const core = new VadCore({}, RATE);
    let t = 0;
    for (let i = 0; i < 20; i += 1) core.push(quietFrame(), t), (t += FRAME_MS);

    // 12 loud frames in total (≈512 ms of "voiced" audio, over the 350 ms bar)
    // but never more than 2 in a row (≈85 ms), under the 150 ms sustained bar.
    for (let burst = 0; burst < 6; burst += 1) {
      core.push(speechFrame(burst), t), (t += FRAME_MS);
      core.push(speechFrame(burst + 1), t), (t += FRAME_MS);
      core.push(quietFrame(), t), (t += FRAME_MS);
    }

    let discarded = 0;
    for (let i = 0; i < 45; i += 1) {
      const batch = core.push(quietFrame(), t);
      t += FRAME_MS;
      if (batch.some((e) => e.type === 'discard')) discarded += 1;
      if (batch.some((e) => e.type === 'utterance')) throw new Error('a rattle must not be sent');
    }
    expect(discarded).toBe(1);
    expect(core.stats.sent).toBe(0);

    // A real word — one sustained run of 10 frames (≈427 ms) — still goes.
    for (let i = 0; i < 10; i += 1) core.push(speechFrame(i), t), (t += FRAME_MS);
    let sent = 0;
    for (let i = 0; i < 45; i += 1) {
      const batch = core.push(quietFrame(), t);
      t += FRAME_MS;
      if (batch.some((e) => e.type === 'utterance')) sent += 1;
    }
    expect(sent).toBe(1);
    expect(core.stats.sent).toBe(1);
  });

  it('reports speech over her as a barge-in, at a higher bar', () => {
    const core = new VadCore({}, RATE);
    let t = 0;
    for (let i = 0; i < 20; i += 1) core.push(quietFrame(), t), (t += FRAME_MS);

    // A modest sound (RMS 0.03) is enough when the room is idle…
    const idle = new VadCore({}, RATE);
    let t2 = 0;
    for (let i = 0; i < 20; i += 1) idle.push(quietFrame(), t2), (t2 += FRAME_MS);
    const modest = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i += 1) modest[i] = 0.026 * Math.sin((2 * Math.PI * 200 * i) / RATE);
    expect(rms(modest)).toBeGreaterThan(0.012);
    expect(rms(modest)).toBeLessThan(0.0204);
    const idleEvents = [...idle.push(modest, t2), ...idle.push(modest, (t2 += FRAME_MS))];
    expect(idleEvents.some((e) => e.type === 'onset')).toBe(true);

    // …but NOT enough to interrupt her: the barge-in bar is ×1.7 for 3 frames.
    const bargeEvents = [
      ...core.push(modest, t, true),
      ...core.push(modest, (t += FRAME_MS), true),
      ...core.push(modest, (t += FRAME_MS), true),
    ];
    expect(bargeEvents.some((e) => e.type === 'onset')).toBe(false);

    // Loud, sustained speech over her is unambiguous.
    const loud = [
      ...core.push(speechFrame(0), t, true),
      ...core.push(speechFrame(1), (t += FRAME_MS), true),
      ...core.push(speechFrame(2), (t += FRAME_MS), true),
    ];
    const onset = loud.find((e) => e.type === 'onset');
    expect(onset).toBeDefined();
    expect(onset).toMatchObject({ type: 'onset', bargeIn: true });
    expect(core.stats.bargeIns).toBe(1);
  });

  it('caps a segment that never goes quiet', () => {
    const core = new VadCore({ maxSpeechMs: 600 }, RATE);
    let t = 0;
    for (let i = 0; i < 100; i += 1) {
      const batch = core.push(speechFrame(i), t);
      t += FRAME_MS;
      const utterance = batch.find((e) => e.type === 'utterance');
      if (utterance && utterance.type === 'utterance') {
        expect(utterance.utterance.reason).toBe('cap');
        expect(utterance.utterance.totalMs).toBeLessThan(1000);
        return;
      }
    }
    throw new Error('the cap never fired');
  });

  it('cancel() throws away a half-spoken clip (mic turned off mid-sentence)', () => {
    const core = new VadCore({}, RATE);
    let t = 0;
    for (let i = 0; i < 10; i += 1) core.push(quietFrame(), t), (t += FRAME_MS);
    for (let i = 0; i < 20; i += 1) core.push(speechFrame(i), t), (t += FRAME_MS);
    expect(core.isCapturing).toBe(true);
    core.cancel();
    expect(core.isCapturing).toBe(false);
    for (let i = 0; i < 40; i += 1) core.push(quietFrame(), t), (t += FRAME_MS);
    expect(core.stats.sent).toBe(0);
  });

  /**
   * The live report this rule set exists for: the door said OUVINDO with the
   * meter moving at −27 dBFS, 679 blocks and no gaps, and no turn ever formed.
   * `toneFrame` is that room: a laptop microphone whose AGC has lifted room tone
   * into the low −30s, with a visitor talking 5 dB over it.
   */
  const toneFrame = (db: number) => {
    const amp = Math.pow(10, db / 20) * Math.SQRT2;
    const data = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i += 1) data[i] = amp * Math.sin((2 * Math.PI * 180 * i) / RATE);
    return data;
  };

  it('hears a voice in a room whose tone is louder than the old silence bar', () => {
    // Room −40 dBFS, voice −27 dBFS. The old continuation bar was
    // `0.55 × speech bar` ≈ −43 dBFS, i.e. UNDER the room: nothing was ever
    // silence, one capture ran to the 20 s cap, and the fallback ear posted no
    // clip at all (measured live: onsets 1, sent 0).
    const core = new VadCore({}, RATE);
    let t = 0;
    for (let i = 0; i < 20; i += 1) core.push(toneFrame(-40), t), (t += FRAME_MS);
    for (let i = 0; i < 60; i += 1) core.push(toneFrame(-27), t), (t += FRAME_MS);
    expect(core.stats.onsets).toBe(1);
    let sent = null as null | (typeof core)['stats'];
    for (let i = 0; i < 60; i += 1) {
      const batch = core.push(toneFrame(-40), t);
      t += FRAME_MS;
      if (batch.some((e) => e.type === 'utterance')) {
        sent = core.stats;
        break;
      }
    }
    expect(sent).not.toBeNull();
    // Closes on SILENCE, not on the 20 s cap — the room counts as quiet now.
    expect(core.stats.lastReason).toBe('silence');
    expect(core.stats.lastTotalMs).toBeLessThan(12000);
  });

  it('keeps the speech bar under the session peak in a loud room', () => {
    // The measured shape: room −40, voice −27, 40 s of the visitor talking in
    // bursts. An un-ceilinged adaptive floor drifts to the voice and the door
    // stops hearing anybody (2 detections out of 12 bursts before the ceiling).
    const core = new VadCore({}, RATE);
    let t = 0;
    let onsets = 0;
    for (let burst = 0; burst < 8; burst += 1) {
      // 1.4 s of room (over the 1.2 s end-of-speech bar), then 1.9 s of voice.
      for (let i = 0; i < 33; i += 1) {
        onsets += core.push(toneFrame(-40), t).filter((e) => e.type === 'onset').length;
        t += FRAME_MS;
      }
      for (let i = 0; i < 45; i += 1) {
        onsets += core.push(toneFrame(-27), t).filter((e) => e.type === 'onset').length;
        t += FRAME_MS;
      }
    }
    // Every burst is heard: the bar can never sit above `peak × peakBarFraction`,
    // and the peak IS the voice.
    expect(onsets).toBe(8);
    expect(core.stats.sent).toBeGreaterThanOrEqual(6);
    // Whatever the room, the bar stays clear of a normal speaking voice.
    expect(core.stats.threshold).toBeLessThan(0.0316); // −30 dBFS
  });

  it('never bills the provider for a steady loud room', () => {
    // A fan, a compressor, a hum: 0 dB of modulation, so any energy gate can
    // cross its own bar on it. The rule is that such a capture must never leave
    // the door: it is cancelled at 400 ms when the bar is room-driven, and
    // dropped at the 20 s cap when it never rose above the room at all.
    const core = new VadCore({ maxSpeechMs: 8000 }, RATE);
    let t = 0;
    for (let i = 0; i < 400; i += 1) core.push(toneFrame(-33), t), (t += FRAME_MS);
    expect(core.stats.sent).toBe(0);
    expect(core.stats.roomOnsets).toBeGreaterThan(0);
    expect(core.stats.lastReason).toBe('roomLevel');
  });
});

/** jsdom's Blob predates `arrayBuffer()`; FileReader is the portable read. */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16-bit PCM WAV with a valid header', async () => {
    const parts = [speechFrame(0), speechFrame(1), speechFrame(2)];
    const blob = encodeWav(parts, RATE, 16000);
    expect(blob.type).toBe('audio/wav');
    const bytes = new Uint8Array(await readBlob(blob));
    const view = new DataView(bytes.buffer);

    const text = (offset: number, length: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + length));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');

    const samples = view.getUint32(40, true) / 2;
    // 3 frames at 48 kHz, decimated to 16 kHz, is a third of the input length.
    expect(samples).toBeGreaterThan(1900);
    expect(samples).toBeLessThan(2100);
    expect(view.getUint32(4, true)).toBe(36 + samples * 2);
  });
});

/**
 * The capture ledger. This is the measurement the AudioWorklet move exists for:
 * a main-thread stall must show up as LATENESS (queue lag) on a worklet and as
 * missing audio (a hole in the audio timeline) on the old ScriptProcessor. The
 * ledger is the thing the door reports, so its arithmetic is pinned here.
 */
describe('BlockLedger', () => {
  const RATE_L = 48000;
  const FRAME_L = 2048;
  const MS = (FRAME_L / RATE_L) * 1000; // ≈ 42.67 ms

  it('counts a clean run as no gaps and no drops', () => {
    const led = new BlockLedger('worklet', FRAME_L, RATE_L);
    for (let i = 0; i < 20; i += 1) {
      // Processed 5 ms after the block's audio finished: healthy queue.
      led.push(i, i * MS, i * MS + MS + 5, 0.2);
    }
    expect(led.blocks).toBe(20);
    expect(led.gaps).toBe(0);
    expect(led.droppedMs).toBe(0);
    expect(led.expectedBlocks).toBe(20);
    expect(led.lateMs).toBeCloseTo(5, 0);
  });

  it('reports a stall as LATE blocks, not lost audio (the worklet contract)', () => {
    const led = new BlockLedger('worklet', FRAME_L, RATE_L);
    for (let i = 0; i < 10; i += 1) led.push(i, i * MS, i * MS + MS + 2, 0.2);
    // The page freezes for 400 ms: every block still arrives, in order, but the
    // 10 that were produced during the stall are processed at the same instant.
    const stallAt = 10 * MS + MS + 400;
    for (let i = 10; i < 20; i += 1) led.push(i, i * MS, stallAt, 0.2);
    expect(led.blocks).toBe(20);
    expect(led.droppedMs).toBe(0); // audio thread lost nothing
    expect(led.gaps).toBe(0); // and the audio timeline is continuous
    expect(led.lateMs).toBeGreaterThan(300); // but the page was behind
  });

  it('reports a sequence jump as DROPPED audio', () => {
    const led = new BlockLedger('worklet', FRAME_L, RATE_L);
    led.push(0, 0, MS, 0.2);
    led.push(1, MS, 2 * MS, 0.2);
    // Blocks 2..5 never reached the page.
    led.push(6, 6 * MS, 7 * MS, 0.2);
    expect(led.blocks).toBe(3);
    expect(led.droppedMs).toBeCloseTo(4 * MS, 1);
  });

  it('marks a gap when the audio timeline itself jumps', () => {
    const led = new BlockLedger('script', FRAME_L, RATE_L);
    led.push(0, 0, MS, 0.2);
    led.push(1, MS, 2 * MS, 0.2);
    led.push(2, MS + 500, 3 * MS, 0.2); // 500 ms hole in the input
    expect(led.gaps).toBe(1);
    expect(led.maxGapMs).toBeGreaterThan(400);
  });

  it('does not call the first block interval a gap (audio-epoch calibration)', () => {
    const led = new BlockLedger('worklet', FRAME_L, RATE_L);
    led.push(0, 0, MS + 3, 0.2);
    // The context was still spinning up: the second block's stamp is 87 ms on.
    led.push(1, 2 * MS, 3 * MS + 3, 0.2);
    expect(led.gaps).toBe(0);
    expect(led.droppedMs).toBe(0);
  });

  it('keeps the capture mode visible so a fallback is never mistaken for the real path', () => {
    expect(new BlockLedger('script', FRAME_L, RATE_L).mode).toBe('script');
    expect(new BlockLedger('worklet', FRAME_L, RATE_L).mode).toBe('worklet');
  });
});

describe('VAD_TAP_SOURCE', () => {
  it('registers the processor the session constructs, with no bundler-only syntax', () => {
    expect(VAD_TAP_SOURCE).toContain("registerProcessor('door-ear-tap'");
    expect(VAD_TAP_SOURCE).toContain('class DoorEarTap extends AudioWorkletProcessor');
    // The worklet is loaded from a Blob: TypeScript types/imports would not resolve.
    expect(VAD_TAP_SOURCE).not.toContain('import ');
    expect(VAD_TAP_SOURCE).not.toContain(': number');
  });

  it('stamps blocks with audio time and reports their peak', () => {
    expect(VAD_TAP_SOURCE).toContain('currentFrame');
    expect(VAD_TAP_SOURCE).toContain('blockStart');
    expect(VAD_TAP_SOURCE).toContain('peak');
    expect(VAD_TAP_SOURCE).toContain('postMessage');
  });
});
