/**
 * The thinking cadence — "she narrates while the silhouette forms"
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6).
 *
 * While the model works, the live screen shows a status word on a ~820ms beat:
 * `LISTENING → READING THE MOMENT → COMPOSING`. It is a narration of a wait nothing
 * can measure, which is why it is words rather than a progress bar — none of the
 * work behind it reports progress, and a bar would be inventing one.
 *
 * The schedule lives here, apart from the component that draws it, because "which
 * word is on screen at t" is the only part of this state that has an exact answer.
 * The flick, the sweeps and the handoff are things you check on a device.
 *
 * THE ARC RESTS BEFORE IT REPEATS. Three words at 820ms is 2460ms, and plenty of
 * waits outlive that — a slow first token, a cold RAG race — so the loop is visible
 * to the reader rather than theoretical. Snapping COMPOSING back to LISTENING the
 * instant she reaches composing reads as the work being thrown away and started
 * over, so COMPOSING holds a second beat first: the arc completes, rests, then goes
 * round again.
 */

/** The three words, in the order she says them. */
export const THINKING_WORDS = [
  'LISTENING',
  'READING THE MOMENT',
  'COMPOSING',
] as const;

export type ThinkingWord = (typeof THINKING_WORDS)[number];

/** One beat — how long a word holds before the next flick (spec: ~820ms). */
export const THINKING_BEAT_MS = 820;

const [LISTENING, READING_THE_MOMENT, COMPOSING] = THINKING_WORDS;

/**
 * One entry per beat, not one per word: COMPOSING occupies the last two, which is
 * the rest described above. Written out rather than computed so the beat a reader
 * sees on screen can be counted off this list.
 */
const CYCLE = [LISTENING, READING_THE_MOMENT, COMPOSING, COMPOSING] as const;

/** One full trip round the arc, rest included. */
export const THINKING_CYCLE_MS = CYCLE.length * THINKING_BEAT_MS;

/**
 * The word showing `elapsedMs` after the wait began.
 *
 * A negative or non-finite input answers with the first word rather than throwing:
 * callers derive `elapsedMs` by subtracting a start timestamp, a clock adjustment
 * can make that negative, and an indicator with no error state should simply open
 * where it would have opened.
 */
export function thinkingWordAt(elapsedMs: number): ThinkingWord {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return LISTENING;

  const beat = Math.floor(elapsedMs / THINKING_BEAT_MS) % CYCLE.length;
  return CYCLE[beat] ?? LISTENING;
}
