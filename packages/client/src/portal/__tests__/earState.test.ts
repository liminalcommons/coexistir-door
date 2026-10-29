/**
 * earState.test.ts — the door's ear readout, pinned to measurements.
 *
 * The owner's failure mode: the tag said OUVINDO, the visitor spoke, and no
 * transcript appeared. Four different faults produce that picture, and these
 * tests hold the line between them — especially that a quiet-but-working mic is
 * NOT reported as "no audio".
 */

import {
  EAR_WARMUP_MS,
  SILENT_RMS,
  classifyMicError,
  dbfsOf,
  dbfsText,
  earNotice,
  earVerdictOf,
  levelFromRms,
} from '../earState';

describe('dbfsOf / dbfsText', () => {
  it('maps full scale to 0 dBFS and the speech bar to about −38 dBFS', () => {
    expect(Math.round(dbfsOf(1))).toBe(0);
    expect(Math.round(dbfsOf(0.012))).toBe(-38);
  });

  it('prints a digital zero as −∞, not as a fake number', () => {
    expect(dbfsOf(0)).toBe(-Infinity);
    expect(dbfsText(0)).toBe('−∞ dBFS');
    expect(dbfsText(0.01)).toBe('-40 dBFS');
  });
});

describe('levelFromRms', () => {
  it('lights the meter for a quiet but working microphone', () => {
    // −40 dBFS is normal speech at arm's length; the old linear curve put it at
    // 0.05 (half of one bar), which looked exactly like a dead capture.
    expect(levelFromRms(0.01)).toBeCloseTo(0.33, 2);
    expect(levelFromRms(0.1)).toBeCloseTo(0.67, 2);
  });

  it('stays at zero for true silence and clamps at 1', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(2)).toBe(1);
  });
});

describe('classifyMicError', () => {
  it('separates a browser decision from a hardware problem', () => {
    expect(classifyMicError('NotAllowedError')).toBe('denied');
    expect(classifyMicError('PermissionDeniedError')).toBe('denied');
    expect(classifyMicError('NotFoundError')).toBe('no-device');
    expect(classifyMicError('NotReadableError')).toBe('busy');
    expect(classifyMicError('OverconstrainedError')).toBe('constraints');
    expect(classifyMicError('SecurityError')).toBe('insecure');
    expect(classifyMicError('TypeError', 'Not supported')).toBe('unavailable');
    expect(classifyMicError('WeirdError', 'something else')).toBe('error');
  });
});

describe('earVerdictOf', () => {
  const base = { blocks: 120, maxRms: 0.02, onsets: 0, threshold: 0.012, listeningMs: 5000 };

  it('says nothing during the warm-up window', () => {
    expect(earVerdictOf({ ...base, listeningMs: EAR_WARMUP_MS - 1 })).toBe('idle');
  });

  it('calls a capture that delivers no blocks "no-frames"', () => {
    expect(earVerdictOf({ ...base, blocks: 0 })).toBe('no-frames');
  });

  it('calls a capture below −50 dBFS "silent", but only once it is confirmed', () => {
    expect(earVerdictOf({ ...base, maxRms: SILENT_RMS / 2, listeningMs: 5000 })).toBe('idle');
    expect(earVerdictOf({ ...base, maxRms: SILENT_RMS / 2, listeningMs: 8000 })).toBe('silent');
    expect(earVerdictOf({ ...base, maxRms: 0, listeningMs: 8000 })).toBe('silent');
  });

  it('never calls a microphone silent after it has heard a syllable', () => {
    expect(
      earVerdictOf({ ...base, maxRms: 0, onsets: 2, listeningMs: 60000 }),
    ).toBe('ok');
  });

  it('separates "audio arrives but the bar is above it" from silence', () => {
    expect(earVerdictOf({ ...base, maxRms: 0.005, threshold: 0.012 })).toBe('below-bar');
  });

  it('is ok when the audio reached the bar (or an onset fired)', () => {
    expect(earVerdictOf({ ...base, onsets: 1, maxRms: 0.005 })).toBe('ok');
    expect(earVerdictOf({ ...base, maxRms: 0.05 })).toBe('ok');
  });
});

describe('earNotice', () => {
  it('explains a blocked microphone in plain Portuguese', () => {
    const notice = earNotice('idle', 'pt', 'denied');
    expect(notice?.title).toBe('O navegador bloqueou o microfone');
    expect(notice?.how).toContain('cadeado');
    expect(notice?.how).toContain('Permitir');
  });

  it('says the door is listening but no audio arrives for a silent capture', () => {
    const notice = earNotice('silent', 'pt');
    expect(notice?.title).toContain('não chega áudio');
    expect(notice?.how).toContain('permissão do microfone');
    expect(earNotice('silent', 'en')?.title).toContain('no audio is arriving');
  });

  it('stays quiet for a healthy ear, a warm-up, or an unspoken quiet room', () => {
    expect(earNotice('ok', 'pt')).toBeNull();
    expect(earNotice('idle', 'pt')).toBeNull();
    // 'below-bar' is disclosed in the rail and the log, never as a door banner:
    // a quiet room where nobody has spoken yet looks exactly like this.
    expect(earNotice('below-bar', 'pt')).toBeNull();
  });

  it('speaks plainly about a capture that delivers no frames', () => {
    expect(earNotice('no-frames', 'pt')?.title).toContain('não está entregando áudio');
  });
});
