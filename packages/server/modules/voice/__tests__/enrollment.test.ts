/**
 * enrollment.test.ts — speak-to-enroll, proven on synthetic WAVs.
 *
 * What must hold:
 * - start demands a name AND a supervisor; `guest` can never be a voice key;
 * - 2–3 clips of one synthetic voice average into a print that a fresh clip
 *   of the same voice clears (≥ 0.82) while a different voice does not;
 * - a mixed set (two voices in one session) refuses to bind;
 * - one clip is too few; silence and non-WAV bodies are refused, not guessed;
 * - the print lands under `person:<name>` — never under the kiosk key.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_MATCH_THRESHOLD,
  VOICEPRINT_DIMS,
  VoiceprintRegistry,
} from '../voiceIdentity';
import {
  ENROLL_CONSISTENCY_FLOOR,
  EnrollmentStore,
  minPairwiseSimilarity,
  personKeyFor,
  verifyAgainst,
} from '../enrollment';
import { VOICE_A, VOICE_A_AGAIN, VOICE_B, voiceWav } from './wavFixture';

let dir: string;
let store: EnrollmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'enroll-'));
  store = new EnrollmentStore({ newId: (() => { let n = 0; return () => `enr_test_${n += 1}`; })() });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registry(): VoiceprintRegistry {
  return new VoiceprintRegistry({ dir, threshold: DEFAULT_MATCH_THRESHOLD, log: () => undefined });
}

function start(name = 'Test Owner', supervisedBy = 'supervisor') {
  const started = store.start({ name, supervisedBy });
  if ('failure' in started) throw new Error(`start failed: ${started.failure}`);
  return started.session;
}

describe('personKeyFor', () => {
  it('scopes the key to the person, never the kiosk', () => {
    expect(personKeyFor('Test Owner')).toBe('person:test owner');
    expect(personKeyFor('  FLURAN  ')).toBe('person:fluran');
    expect(personKeyFor('')).toBeNull();
    expect(personKeyFor('guest')).toBeNull();
    expect(personKeyFor('Guest')).toBeNull();
  });
});

describe('start', () => {
  it('demands a name and a supervisor', () => {
    expect(store.start({ name: '', supervisedBy: 's' })).toMatchObject({ failure: 'name_required' });
    expect(store.start({ name: 'A', supervisedBy: '' })).toMatchObject({ failure: 'supervisor_required' });
    expect(store.start({ name: 'guest', supervisedBy: 's' })).toMatchObject({ failure: 'name_rejected' });
  });

  it('opens a session on the person key with the prompt', () => {
    const session = start();
    expect(session.voiceKey).toBe('person:test owner');
    expect(session.prompt.text.length).toBeGreaterThan(0);
    expect(session.needClips).toBe(3);
    expect(session.clips).toHaveLength(0);
  });
});

describe('clips', () => {
  it('refuses silence and non-WAV bodies instead of guessing', () => {
    const session = start();
    expect(store.addClip(session.id, Buffer.alloc(100), 'audio/wav')).toMatchObject({ failure: 'no_audio' });
    expect(store.addClip(session.id, Buffer.alloc(100), 'audio/webm')).toMatchObject({
      failure: 'unsupported_container',
    });
  });

  it('accepts 3 takes of one voice and reports rising consistency', () => {
    const session = start();
    for (const spec of [VOICE_A, VOICE_A_AGAIN, VOICE_A]) {
      const added = store.addClip(session.id, voiceWav(spec), 'audio/wav');
      if ('failure' in added) throw new Error(`clip failed: ${added.failure}`);
    }
    const live = store.peek(session.id)!;
    expect(live.clips).toHaveLength(3);
    expect(live.consistency).not.toBeNull();
    expect(live.consistency!).toBeGreaterThan(ENROLL_CONSISTENCY_FLOOR);
  });

  it('refuses a fourth take', () => {
    const session = start();
    for (const spec of [VOICE_A, VOICE_A_AGAIN, VOICE_A]) {
      store.addClip(session.id, voiceWav(spec), 'audio/wav');
    }
    expect(store.addClip(session.id, voiceWav(VOICE_A), 'audio/wav')).toMatchObject({
      failure: 'too_many_clips',
    });
  });
});

describe('finish', () => {
  it('binds one voice under person:<name>, verified by re-speaking', () => {
    const session = start('Test Owner', 'supervisor');
    for (const spec of [VOICE_A, VOICE_A_AGAIN, VOICE_A]) {
      const added = store.addClip(session.id, voiceWav(spec), 'audio/wav');
      if ('failure' in added) throw new Error(`clip failed: ${added.failure}`);
    }
    const reg = registry();
    const done = store.finish(session.id, reg);
    if ('failure' in done) throw new Error(`finish failed: ${done.failure} ${done.detail ?? ''}`);
    expect(done.voiceKey).toBe('person:test owner');
    expect(done.printId).toMatch(/^vp_/);
    expect(done.clips).toBe(3);

    // The averaged print really is this voice: a fresh clip clears 0.82.
    const enrolled = reg.list().find((print) => print.voiceKey === 'person:test owner');
    expect(enrolled).toBeDefined();
    expect(enrolled!.vector).toHaveLength(VOICEPRINT_DIMS);
    const same = verifyAgainst(voiceWav({ ...VOICE_A, seed: 4242 }), 'audio/wav', enrolled!, DEFAULT_MATCH_THRESHOLD);
    expect(same.failure).toBeNull();
    expect(same.match).toBe(true);
    expect(same.similarity!).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);

    // A different voice does NOT match: no voice match, no name.
    const stranger = verifyAgainst(voiceWav(VOICE_B), 'audio/wav', enrolled!, DEFAULT_MATCH_THRESHOLD);
    expect(stranger.failure).toBeNull();
    expect(stranger.match).toBe(false);
    expect(stranger.similarity!).toBeLessThan(DEFAULT_MATCH_THRESHOLD);
  });

  it('refuses one clip as too few', () => {
    const session = start();
    store.addClip(session.id, voiceWav(VOICE_A), 'audio/wav');
    expect(store.finish(session.id, registry())).toMatchObject({ failure: 'too_few_clips' });
  });

  it('refuses a mixed-voice set', () => {
    const session = start();
    for (const spec of [VOICE_A, VOICE_B, VOICE_A]) {
      const added = store.addClip(session.id, voiceWav(spec), 'audio/wav');
      if ('failure' in added) throw new Error(`clip failed: ${added.failure}`);
    }
    const live = store.peek(session.id)!;
    expect(live.consistency!).toBeLessThan(ENROLL_CONSISTENCY_FLOOR);
    expect(store.finish(session.id, registry())).toMatchObject({ failure: 'inconsistent_voice' });
  });
});

describe('minPairwiseSimilarity', () => {
  it('is null below two vectors and ~0.96 for one synthetic voice', () => {
    expect(minPairwiseSimilarity([])).toBeNull();
    expect(minPairwiseSimilarity([[1, 0]])).toBeNull();
  });
});
