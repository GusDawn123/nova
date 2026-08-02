import type {
  MeetingNotes,
  MeetingTranscriptTurn,
  NotesStatus,
} from "@nova/shared";

/**
 * Ports for the meetings read surface (Phase 8.5, `docs/DESIGN/notes-ui.md` §6).
 * Module-local zod lives here by convention; these shapes are all internal, so the
 * only schemas involved are the shared wire models the routes parse on the way out.
 */

/**
 * One meeting as the reader hands it to the projection — the DB row with its jsonb
 * already parsed and upcast.
 *
 * `notes` and `liveNotes` arrive as v2 {@link MeetingNotes} regardless of what is
 * stored: the adapter reads through `storedNotesSchema` (the v1 ∪ v2 boundary) and
 * upcasts, which is precisely the work a direct-from-PostgREST client read could not
 * do. `hasFollowUp` is a boolean rather than the draft because the list only needs to
 * know whether the chip shows.
 */
export interface MeetingListRow {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly notesStatus: NotesStatus;
  readonly notes: MeetingNotes | null;
  readonly liveNotes: MeetingNotes | null;
  readonly hasFollowUp: boolean;
}

/** The DB seam the meetings routes read through. User-scoped, soft-delete aware. */
export interface MeetingsReader {
  /**
   * The caller's meetings, newest first, soft-deleted excluded, capped at `limit`.
   * Returning exactly `limit` rows is the signal the list was truncated — the route
   * logs that rather than letting a cut-off list read as a complete one.
   */
  listMeetings(userId: string, limit: number): Promise<MeetingListRow[]>;

  /** Calls STARTED at or after `since` — the list header's month counter. */
  countMeetingsSince(userId: string, since: Date): Promise<number>;

  /**
   * The meeting's final transcript turns, ordered for reading.
   *
   * `null` means the meeting is missing, foreign, or soft-deleted — the three cases
   * the route collapses into one uniform 404, so existence never leaks. An empty
   * ARRAY is a different and legitimate answer: the meeting is yours and has no
   * turns yet. Conflating them would 404 every call that has not spoken.
   */
  readTranscript(
    meetingId: string,
    userId: string,
  ): Promise<MeetingTranscriptTurn[] | null>;
}

/** Structured logging seam (RULES §10) — `request_id`/`user_id`, never content. */
export interface MeetingsLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}
