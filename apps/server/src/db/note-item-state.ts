import type { Pool } from "pg";
import { z } from "zod";

import type { StoredItemState } from "../modules/notes/item-completion.js";

/**
 * `public.note_item_state` store — per-item user state over a meeting's notes
 * (Phase 8.5, `docs/DESIGN/notes-ui.md` §6.3; migration `20260728140000`).
 *
 * Goes through a pg `Pool` rather than the supabase-js REST client, matching
 * `db/live-notes.ts`: this is a small, hot, per-tap write, and an HTTP round trip
 * per checkbox is the wrong tool. It rides the memoised jobs pool.
 *
 * Both directions are parsed at the boundary (RULES §1). Reads are user-scoped AND
 * `deleted_at is null` — the policy enforces the same, but a service-role connection
 * bypasses RLS, so the predicate has to be here too.
 */

/** One stored row as Postgres returns it. */
const stateRowSchema = z.object({
  item_id: z.string(),
  item_text: z.string(),
  completed_at: z.union([z.string(), z.date()]).nullable(),
});

/** The seam the notes routes read and write completion through. */
export interface NoteItemStateStore {
  /** Every stored row for one meeting, in no guaranteed order. */
  readForMeeting(meetingId: string, userId: string): Promise<StoredItemState[]>;
  /**
   * Record a check or uncheck.
   *
   * `itemText` is supplied by the CALLER FROM THE CURRENT NOTES, never by the
   * client — that is what stops a client desyncing the staleness guard by claiming
   * text that never appeared in the notes. Re-checking an already-checked item
   * refreshes `item_text` to whatever it reads now, so an item the user re-affirms
   * after a reword stops drifting toward the threshold.
   */
  setCompleted(input: {
    meetingId: string;
    userId: string;
    itemId: string;
    itemText: string;
    completed: boolean;
    now: Date;
  }): Promise<void>;
}

/** Build a {@link NoteItemStateStore} over an existing pool. */
export function createNoteItemStateStore(pool: Pool): NoteItemStateStore {
  return {
    async readForMeeting(
      meetingId: string,
      userId: string,
    ): Promise<StoredItemState[]> {
      const res = await pool.query(
        `select item_id, item_text, completed_at
           from note_item_state
          where meeting_id = $1 and user_id = $2 and deleted_at is null`,
        [meetingId, userId],
      );
      return res.rows.map((row) => {
        const parsed = stateRowSchema.parse(row);
        return {
          itemId: parsed.item_id,
          itemText: parsed.item_text,
          completedAt:
            parsed.completed_at === null
              ? null
              : new Date(parsed.completed_at).toISOString(),
        };
      });
    },

    async setCompleted({
      meetingId,
      userId,
      itemId,
      itemText,
      completed,
      now,
    }): Promise<void> {
      // One statement, no read-modify-write: the (meeting_id, item_id) primary key
      // makes the conflict target exact, so two rapid taps cannot interleave into a
      // lost update. An UNCHECK writes completed_at = null rather than deleting the
      // row — "the user unchecked this" is a fact worth keeping distinct from "the
      // user never touched this", and a delete would let a stale client re-read the
      // absence as the latter.
      await pool.query(
        `insert into note_item_state
           (meeting_id, user_id, item_id, item_text, completed_at, updated_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (meeting_id, item_id) do update
           set item_text = excluded.item_text,
               completed_at = excluded.completed_at,
               updated_at = excluded.updated_at,
               -- Un-delete on write: a soft-deleted row that the user acts on again
               -- is live again, not a silently ignored no-op.
               deleted_at = null`,
        [
          meetingId,
          userId,
          itemId,
          itemText,
          completed ? now.toISOString() : null,
          now.toISOString(),
        ],
      );
    },
  };
}
