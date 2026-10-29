/**
 * doorTimings.test.ts — the waterfall, pinned.
 *
 * The point of these tests is that the NUMBERS KEEP THEIR MEANING: every stage
 * is a delta from the last voiced frame, the base says where it came from, and a
 * stage that never happened is null rather than zero. A zero would read like a
 * perfect stage; a null reads like a missing one.
 */

import {
  DoorTurnTimings,
  clearDoorTimings,
  emitDoorTiming,
  formatDoorTiming,
  recentDoorTimings,
  type DoorTimingRow,
} from '../doorTimings';

describe('DoorTurnTimings', () => {
  beforeEach(() => clearDoorTimings());

  it('measures stt / grogg / tts-first-chunk from the last voiced frame', () => {
    const timings = new DoorTurnTimings(
      { base: 10_000, baseSource: 'provider', path: 'stream', closedBy: 'speech_final', text: 'oi' },
      { log: () => undefined },
    );
    timings.mark('stt', 10_620); // endpointing + relay
    timings.mark('grogg', 10_840); // the /turn bridge
    timings.mark('ttsFirstChunk', 11_190); // first audio the visitor hears

    const row = timings.finish();
    expect(row.stt).toBe(620);
    expect(row.grogg).toBe(840);
    expect(row.ttsFirstChunk).toBe(1190);
    expect(row.ttfa).toBe(1190);
    // Stage-to-stage, so a regression can be attributed to one hop.
    expect(row.deltas).toEqual({ sttToGrogg: 220, groggToTts: 350 });
    expect(row.base).toEqual({ at: 10_000, source: 'provider' });
    expect(row.path).toBe('stream');
    expect(row.closedBy).toBe('speech_final');
  });

  it('reports a stage that never happened as null, never as zero', () => {
    const timings = new DoorTurnTimings(
      { base: 1000, baseSource: 'vad', path: 'batch' },
      { log: () => undefined },
    );
    timings.mark('stt', 1300);
    const row = timings.finish();
    expect(row.stt).toBe(300);
    expect(row.grogg).toBeNull();
    expect(row.ttsFirstChunk).toBeNull();
    expect(row.ttfa).toBeNull();
    expect(row.deltas).toEqual({ sttToGrogg: null, groggToTts: null });
  });

  it('cannot produce a delta without a base, and says so', () => {
    const timings = new DoorTurnTimings(
      { base: null, baseSource: 'none', path: 'stream' },
      { log: () => undefined },
    );
    timings.mark('stt', 5000);
    const row = timings.finish();
    expect(row.stt).toBeNull();
    expect(row.base.source).toBe('none');
  });

  it('lets the first mark win, so a retried stage cannot rewrite history', () => {
    const timings = new DoorTurnTimings({ base: 0, baseSource: 'provider', path: 'stream' }, { log: () => undefined });
    timings.mark('stt', 400);
    timings.mark('stt', 900);
    expect(timings.finish().stt).toBe(400);
  });

  it('carries the turn id once the bridge has answered', () => {
    const timings = new DoorTurnTimings({ base: 0, baseSource: 'provider', path: 'stream' }, { log: () => undefined });
    timings.setTurnId('turn-42');
    expect(timings.finish().turnId).toBe('turn-42');
  });

  it('logs exactly once even when finish() is called twice', () => {
    const lines: string[] = [];
    const timings = new DoorTurnTimings(
      { base: 0, baseSource: 'provider', path: 'stream' },
      { log: (_row, line) => lines.push(line) },
    );
    timings.mark('stt', 500);
    timings.finish();
    timings.finish();
    expect(lines).toHaveLength(1);
  });
});

describe('formatDoorTiming', () => {
  it('prints one greppable line naming every stage', () => {
    const row: DoorTimingRow = {
      turnId: 'turn-7',
      base: { at: 0, source: 'provider' },
      stt: 620,
      grogg: 840,
      ttsFirstChunk: 1190,
      deltas: { sttToGrogg: 220, groggToTts: 350 },
      ttfa: 1190,
      path: 'stream',
      closedBy: 'speech_final',
      text: 'quais são as tarefas',
      at: 0,
    };
    const line = formatDoorTiming(row);
    expect(line).toContain('[door-timing]');
    expect(line).toContain('path=stream');
    expect(line).toContain('base=provider');
    expect(line).toContain('stt=620');
    expect(line).toContain('grogg=840');
    expect(line).toContain('tts-first-chunk=1190');
    expect(line).toContain('ttfa=1190');
    expect(line).toContain('by=speech_final');
    expect(line).toContain('turn-7');
  });

  it('prints a dash for a missing stage instead of a fake number', () => {
    const line = formatDoorTiming({
      turnId: '',
      base: { at: 0, source: 'none' },
      stt: null,
      grogg: null,
      ttsFirstChunk: null,
      deltas: { sttToGrogg: null, groggToTts: null },
      ttfa: null,
      path: 'batch',
      closedBy: null,
      text: '',
      at: 0,
    });
    expect(line).toContain('stt=—');
    expect(line).toContain('ttfa=—');
    expect(line).toContain('by=—');
  });
});

describe('recentDoorTimings', () => {
  beforeEach(() => clearDoorTimings());

  it('keeps a bounded window, newest last', () => {
    for (let i = 0; i < 5; i += 1) {
      emitDoorTiming(
        {
          turnId: `turn-${i}`,
          base: { at: 0, source: 'provider' },
          stt: i,
          grogg: null,
          ttsFirstChunk: null,
          deltas: { sttToGrogg: null, groggToTts: null },
          ttfa: null,
          path: 'stream',
          closedBy: null,
          text: '',
          at: 0,
        },
        { log: () => undefined, keep: 3 },
      );
    }
    const rows = recentDoorTimings();
    expect(rows.map((r) => r.turnId)).toEqual(['turn-2', 'turn-3', 'turn-4']);
  });
});
