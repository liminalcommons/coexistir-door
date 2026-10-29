/**
 * doorState.test.ts — the readout cannot disagree with itself.
 *
 * The owner's screenshot: tag IDLE, caption "Pode falar", dock STOP. These
 * tests pin the replacement: one union, one word per state, and a priority that
 * cannot be argued with.
 */
import { DOOR_COPY, doorStateOf, isEarOpen } from '../doorState';

describe('doorStateOf', () => {
  it('is deaf whenever the mic is off and nothing is playing', () => {
    expect(doorStateOf({ micOn: false, speaking: false, thinking: false })).toBe('deaf');
    // Thinking cannot happen with a closed ear: nothing was captured.
    expect(doorStateOf({ micOn: false, speaking: false, thinking: true })).toBe('deaf');
  });

  it('is listening as the resting state of an open ear — forever, not for a turn', () => {
    expect(doorStateOf({ micOn: true, speaking: false, thinking: false })).toBe('listening');
  });

  it('reports what the room is waiting on', () => {
    expect(doorStateOf({ micOn: true, speaking: false, thinking: true })).toBe('thinking');
    expect(doorStateOf({ micOn: true, speaking: true, thinking: true })).toBe('speaking');
  });

  it('keeps speaking true even with the mic shut (her voice is an audible fact)', () => {
    expect(doorStateOf({ micOn: false, speaking: true, thinking: false })).toBe('speaking');
  });

  it('has exactly one copy line per state, in both languages, and no "tap to send"', () => {
    for (const lang of ['pt', 'en'] as const) {
      for (const state of ['deaf', 'listening', 'thinking', 'speaking'] as const) {
        const copy = DOOR_COPY[lang][state];
        expect(copy.label.length).toBeGreaterThan(2);
        expect(copy.hint.length).toBeGreaterThan(5);
        // The LABEL is the readout, and it may never name a control that does
        // not exist. (The speaking hint legitimately mentions talking over her:
        // that is barge-in, and it is not a button.)
        expect(copy.label).not.toMatch(/parar|stop|enviar|send|interromper|interrupt|toque|tap/i);
      }
    }
    expect(DOOR_COPY.pt.listening.label).toBe('OUVINDO');
    expect(DOOR_COPY.pt.deaf.label).toBe('MIC DESLIGADO');
  });

  it('only the deaf state is a closed ear', () => {
    expect(isEarOpen('deaf')).toBe(false);
    expect(isEarOpen('listening')).toBe(true);
    expect(isEarOpen('thinking')).toBe(true);
    expect(isEarOpen('speaking')).toBe(true);
  });
});
