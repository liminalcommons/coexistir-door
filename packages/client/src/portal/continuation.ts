/**
 * continuation — when two clips are really ONE question.
 *
 * The owner's locked VAD ends an utterance after ~1.2 s of silence, so a breath
 * in the middle of a sentence splits it: clip 1 is answered with no idea what
 * clip 2 will say, and clip 2 is answered with no context. The fix is to merge
 * the continuation instead of answering it (review #11).
 *
 * The rule, deliberately tiny and testable: if the new clip's ONSET lands within
 * `CONTINUATION_MS` after the previous clip was auto-sent, the visitor did not
 * finish — cancel turn 1 and re-send both clips as one question.
 *
 * A barge-in is NOT a continuation: those words interrupt an answer she has
 * already started, and the page clears the last send when it cuts her.
 */

/** Window after an auto-send in which new speech still belongs to the same turn. */
export const CONTINUATION_MS = 1500;

/** How many clips one question may grow to before it is answered as it stands. */
export const MAX_MERGES = 3;

/**
 * The gap in ms when `newOnsetAt` continues `previousSentAt`, else null.
 * Both are `performance.now()` values from the same page.
 */
export function continuationGap(
  previousSentAt: number | null,
  newOnsetAt: number,
): number | null {
  if (previousSentAt === null) return null;
  const gap = newOnsetAt - previousSentAt;
  // Before the send (or absurdly long after it): not a continuation.
  if (!Number.isFinite(gap) || gap < 0 || gap > CONTINUATION_MS) return null;
  return Math.round(gap);
}

/**
 * Join two parts of one sentence into ONE question, for the streaming path.
 *
 * The batch path can merge the PCM and re-transcribe; a stream has no clip to
 * re-send — the words are already text. Joining the text is the same question
 * (`quero falar com` + `a Mara`), and it is strictly cheaper: no second Deepgram
 * call, no re-decode. The only thing to get right is not to double a space.
 */
export function mergeTranscripts(first: string, second: string): string {
  const a = (first ?? '').trim().replace(/\s+([,.;:!?])/g, '$1');
  const b = (second ?? '').trim();
  if (!a) return b;
  if (!b) return a;
  // A sentence that already ended keeps its full stop and starts a new one;
  // anything else is a continuation of the same clause.
  return `${a} ${b}`.replace(/\s+/g, ' ').trim();
}
