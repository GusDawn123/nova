import type { MeetingTranscriptTurn } from '@nova/shared';

/**
 * Transcript tab presentation logic (`docs/DESIGN/notes-ui.md` §7.6).
 *
 * Both vendor-supplied fields are nullable, and neither null is a formatting
 * detail — each is a claim we are not entitled to make. A missing offset must not
 * borrow a neighbour's, and a missing speaker label must not be read as "the same
 * unknown person", so both cases are handled by declining to guess.
 */

/** One speaker's consecutive run of turns, as the Transcript tab draws it. */
export type TranscriptBlock = {
  /** The diarized label, or null when the vendor gave none. */
  readonly speaker: string | null;
  /** The offset of the block's FIRST turn; null when that turn had none. */
  readonly tsMs: number | null;
  /** Each turn's content, in the order it was said. */
  readonly lines: string[];
};

/**
 * A call-relative offset as `mm:ss`. Minutes are not wrapped at 60: a 90-minute
 * call is ordinary, and rendering `30:00` would misstate when something was said.
 */
export function formatCallClock(tsMs: number | null): string | null {
  if (tsMs === null) {
    return null;
  }

  const totalSeconds = Math.floor(tsMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Collapse consecutive turns from one speaker into a single block.
 *
 * An unlabelled turn NEVER merges with the one before it. Merging two nulls would
 * assert that the same person said both, which the diarizer never claimed — so
 * unlabelled turns stay separate and the transcript reads as the record it is.
 */
export function groupTranscriptBySpeaker(
  turns: readonly MeetingTranscriptTurn[],
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];

  for (const turn of turns) {
    const open = blocks.at(-1);
    const continues =
      open !== undefined && turn.speaker !== null && open.speaker === turn.speaker;

    if (continues) {
      open.lines.push(turn.content);
      continue;
    }

    blocks.push({
      speaker: turn.speaker,
      tsMs: turn.ts_ms,
      lines: [turn.content],
    });
  }

  return blocks;
}
