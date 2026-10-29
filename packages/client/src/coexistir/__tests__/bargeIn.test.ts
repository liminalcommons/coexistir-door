/**
 * bargeIn.test.ts — the mic gate that cuts the agent off.
 *
 * jsdom has no microphone, so the analyser is faked. What is proven is the
 * decision logic the room depends on: speech only interrupts while the agent is
 * speaking, two loud frames are needed, and `simulateSpeech()` runs the exact
 * same handler a real detection runs (that is what the rig harness calls).
 */

import { installBargeIn } from '../bargeIn';

function loudContext() {
  const trackStop = jest.fn();
  const close = jest.fn();
  class FakeAnalyser {
    fftSize = 1024;
    getFloatTimeDomainData(target: Float32Array) {
      target.fill(0.5); // well above the 0.02 threshold
    }
  }
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect: () => undefined };
    }
    createAnalyser() {
      return new FakeAnalyser();
    }
    close = close;
  }
  const getUserMedia = jest.fn(async () => ({
    getTracks: () => [{ stop: trackStop }],
  }));
  return { getUserMedia, FakeAudioContext, trackStop, close };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('installBargeIn', () => {
  it('fires when the member talks over a speaking agent', async () => {
    const { getUserMedia, FakeAudioContext } = loudContext();
    const onBargeIn = jest.fn();
    let speaking = true;

    const handle = installBargeIn({
      isSpeaking: () => speaking,
      onBargeIn,
      getUserMedia: getUserMedia as never,
      AudioContextImpl: FakeAudioContext as never,
      intervalMs: 10,
      frames: 2,
      threshold: 0.02,
    });

    expect(await handle.start()).toBe(true);
    await sleep(120);

    expect(onBargeIn).toHaveBeenCalled();
    expect(onBargeIn.mock.calls[0][0]).toBe('vad');
    expect(handle.lastTriggeredAt).not.toBeNull();

    // Once the agent stops speaking the mic loop goes quiet.
    speaking = false;
    onBargeIn.mockClear();
    await sleep(60);
    expect(onBargeIn).not.toHaveBeenCalled();

    handle.stop();
    expect(handle.listening).toBe(false);
  });

  it('never interrupts while the agent is silent', async () => {
    const { getUserMedia, FakeAudioContext } = loudContext();
    const onBargeIn = jest.fn();
    const handle = installBargeIn({
      isSpeaking: () => false,
      onBargeIn,
      getUserMedia: getUserMedia as never,
      AudioContextImpl: FakeAudioContext as never,
      intervalMs: 10,
    });
    await handle.start();
    await sleep(80);
    expect(onBargeIn).not.toHaveBeenCalled();
    handle.stop();
  });

  it('simulated speech takes the same path and is labelled honestly', () => {
    const onBargeIn = jest.fn();
    const handle = installBargeIn({ isSpeaking: () => true, onBargeIn });
    const at = handle.simulateSpeech();
    expect(onBargeIn).toHaveBeenCalledWith('simulated');
    expect(at).toBe(handle.lastTriggeredAt);
  });

  it('releases the mic when stopped', async () => {
    const { getUserMedia, FakeAudioContext, trackStop, close } = loudContext();
    const handle = installBargeIn({
      isSpeaking: () => true,
      onBargeIn: () => undefined,
      getUserMedia: getUserMedia as never,
      AudioContextImpl: FakeAudioContext as never,
      intervalMs: 10,
    });
    await handle.start();
    handle.stop();
    expect(trackStop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('reports unavailable when the browser has no mic API', async () => {
    const handle = installBargeIn({
      isSpeaking: () => true,
      onBargeIn: () => undefined,
      getUserMedia: undefined,
      AudioContextImpl: undefined as never,
    });
    expect(await handle.start()).toBe(false);
  });
});
