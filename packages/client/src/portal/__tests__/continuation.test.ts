/**
 * continuation.test.ts — when two clips are ONE question.
 *
 * Review #11: a pause INSIDE a sentence used to become two turns — the first
 * answered with no idea what the rest would say, the second answered with no
 * context. The page merges them when the new onset lands inside the window;
 * these tests pin the window's edges so the merge cannot quietly widen.
 */
import { CONTINUATION_MS, MAX_MERGES, continuationGap, mergeTranscripts } from '../continuation';

describe('continuationGap', () => {
  it('has no opinion when nothing was sent yet', () => {
    expect(continuationGap(null, 5000)).toBeNull();
  });

  it('merges speech that resumes immediately after the auto-send', () => {
    expect(continuationGap(1000, 1000)).toBe(0);
    expect(continuationGap(1000, 1100)).toBe(100);
  });

  it('merges at the edge of the window and refuses one ms past it', () => {
    expect(continuationGap(1000, 1000 + CONTINUATION_MS)).toBe(CONTINUATION_MS);
    expect(continuationGap(1000, 1001 + CONTINUATION_MS)).toBeNull();
  });

  it('never merges speech that started BEFORE the send (that is a barge-in)', () => {
    expect(continuationGap(1000, 999)).toBeNull();
    expect(continuationGap(1000, 0)).toBeNull();
  });

  it('never merges across a real pause', () => {
    // A visitor who thinks for two seconds is asking a new question.
    expect(continuationGap(1000, 3000)).toBeNull();
    expect(continuationGap(1000, 60000)).toBeNull();
  });

  it('keeps a bounded number of merges per question', () => {
    expect(MAX_MERGES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_MERGES)).toBe(true);
  });
});

/**
 * The STREAMING form of the merge. There is no clip to re-send, so the two
 * halves are joined as text: same question, one Deepgram call instead of two.
 */
describe('mergeTranscripts', () => {
  it("joins a sentence split by a breath, without doubling the space", () => {
    expect(mergeTranscripts('quero falar com', 'a Mara')).toBe('quero falar com a Mara');
    expect(mergeTranscripts('quais são as tarefas ', ' abertas da casa')).toBe(
      'quais são as tarefas abertas da casa',
    );
  });

  it('keeps the punctuation of the first half exactly once', () => {
    expect(mergeTranscripts('me dá o briefing ,', 'por favor')).toBe('me dá o briefing, por favor');
    expect(mergeTranscripts('e aí?', 'tudo bem')).toBe('e aí? tudo bem');
  });

  it('returns whichever half exists when one is empty', () => {
    expect(mergeTranscripts('', 'a Mara')).toBe('a Mara');
    expect(mergeTranscripts('a Mara', '')).toBe('a Mara');
    expect(mergeTranscripts('   ', '  ')).toBe('');
  });

  it('collapses whitespace so a merged question has no ragged gaps', () => {
    expect(mergeTranscripts('quero   falar', 'com    a Mara')).toBe('quero falar com a Mara');
  });
});
