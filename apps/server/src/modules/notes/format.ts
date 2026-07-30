import type { TranscriptTurn } from "./ports.js";

/**
 * Prompt-facing transcript rendering, shared by the single-pass pipeline and the
 * map step (Task 4) so both render turns identically. Diarized turns become
 * `[mm:ss] Speaker: text` lines — the timestamp anchors relative-deadline
 * reasoning and the speaker label is the only source of an action-item owner
 * (adr-0006 §6: owners come from diarized labels, never invented).
 */

/** Render diarized turns as `[mm:ss] Speaker: text` lines for a prompt. */
export function formatTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((turn) => {
      const who = turn.speaker ?? "Unknown";
      const stamp =
        turn.tsMs !== null ? `[${formatTimestamp(turn.tsMs)}] ` : "";
      return `${stamp}${who}: ${turn.text}`;
    })
    .join("\n");
}

/** `mm:ss` from a millisecond offset. */
export function formatTimestamp(tsMs: number): string {
  const totalSeconds = Math.floor(tsMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
