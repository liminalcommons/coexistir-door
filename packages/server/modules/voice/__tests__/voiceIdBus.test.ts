/**
 * voiceIdBus.test.ts — the ear→turn bridge, without HTTP.
 *
 * The rules that make identity safe on a public door:
 * - an observation is consumed once (a duplicated/merged turn cannot steal it);
 * - it expires (a question typed long after a clip never inherits a voice);
 * - a traceId pins the exact clip when a room has more than one door;
 * - claim resolution mutates the same observation a later turn will read.
 */

import { VoiceIdBus, observationFrom, newVoiceTraceId } from '../voiceIdBus';
import type { VoiceFingerprint } from '../voiceIdentity';
import { emptyFingerprint } from '../voiceIdentity';

function fingerprint(overrides: Partial<VoiceFingerprint> = {}): VoiceFingerprint {
  return {
    ...emptyFingerprint('unenrolled', null, 4, 0.82),
    printId: 'vp_test001',
    matched: false,
    similarity: 0.41,
    dims: 52,
    durationSec: 2.4,
    voicedSec: 2.1,
    ...overrides,
  };
}

function busWithClock(start = 1_000) {
  let now = start;
  const bus = new VoiceIdBus({ now: () => now, log: () => undefined });
  return { bus, advance: (ms: number) => (now += ms) };
}

describe('VoiceIdBus', () => {
  it('attaches the freshest observation to a turn exactly once', () => {
    const { bus } = busWithClock();
    const observation = bus.put(
      observationFrom({
        fingerprint: fingerprint(),
        room: 'coexistir',
        traceId: 'v_one',
        now: 1_000,
      }),
    );

    const attached = bus.attach('coexistir', { turnId: 't_one' });
    expect(attached).toBe(observation);
    expect(attached!.turnId).toBe('t_one');

    // A second turn in the same room gets nothing: the clip belonged to one turn.
    expect(bus.attach('coexistir', { turnId: 't_two' })).toBeNull();
  });

  it('expires an observation instead of lending a stale voice', () => {
    const { bus, advance } = busWithClock();
    bus.put(
      observationFrom({
        fingerprint: fingerprint(),
        room: 'coexistir',
        traceId: 'v_old',
        now: 1_000,
      }),
    );
    advance(25_000);
    expect(bus.attach('coexistir', { turnId: 't_late' })).toBeNull();
  });

  it('pins the exact clip when a traceId is supplied', () => {
    const { bus } = busWithClock();
    bus.put(observationFrom({ fingerprint: fingerprint(), room: 'coexistir', traceId: 'v_a', now: 1_000 }));
    bus.put(
      observationFrom({
        fingerprint: fingerprint({ printId: 'vp_other' }),
        room: 'coexistir',
        traceId: 'v_b',
        now: 1_010,
      }),
    );
    const attached = bus.attach('coexistir', { turnId: 't_pin', traceId: 'v_a' });
    expect(attached?.traceId).toBe('v_a');
    // The fresher one is still claimable by the next turn.
    expect(bus.attach('coexistir', { turnId: 't_next' })?.traceId).toBe('v_b');
  });

  it('does not mix rooms', () => {
    const { bus } = busWithClock();
    bus.put(observationFrom({ fingerprint: fingerprint(), room: 'chapel', traceId: 'v_c', now: 1_000 }));
    expect(bus.attach('coexistir', { turnId: 't_x' })).toBeNull();
    expect(bus.attach('chapel', { turnId: 't_y' })?.traceId).toBe('v_c');
  });

  it('mutates the observation when a claim resolves, and publishes it', () => {
    const { bus } = busWithClock();
    const observation = bus.put(
      observationFrom({
        fingerprint: fingerprint({ status: 'identified', voiceKey: 'owl:spk_07', matched: true, similarity: 0.95 }),
        room: 'coexistir',
        traceId: 'v_claim',
        now: 1_000,
      }),
    );
    expect(observation.claimStatus).toBe('pending');
    const events: string[] = [];
    bus.subscribe((event) => events.push(event.event));

    bus.setClaim(observation, { name: 'Ana', status: 'verified' }, 'resolved');
    expect(observation.claim).toEqual({ name: 'Ana', status: 'verified' });
    expect(observation.claimStatus).toBe('resolved');

    const attached = bus.attach('coexistir', { turnId: 't_claim' });
    expect(attached?.claim?.name).toBe('Ana');
    expect(events).toEqual(['claim', 'attached']);
    expect(bus.eventLog(2).map((event) => event.speaker)).toEqual(['Ana', 'Ana']);
  });

  it('makes trace ids that are unique and log-safe', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newVoiceTraceId()));
    expect(ids.size).toBe(50);
    expect([...ids].every((id) => /^v_[0-9a-z]+_[0-9a-z]{5}$/.test(id))).toBe(true);
  });
});
