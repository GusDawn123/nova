import type { MeetingListItem } from "@nova/shared";

import type { MeetingListRow } from "./ports.js";

/**
 * Row → card projection (Phase 8.5, `docs/DESIGN/notes-ui.md` §6.1). PURE: no I/O,
 * no clock, no throw — every field is derived from the row it is handed.
 *
 * This is where the notes blob stops. Everything downstream of here sees nine flat
 * fields, which is the whole point of the route: the client never learns that `tldr`
 * lives inside a versioned jsonb document, so it can never be broken by that
 * document's shape changing.
 */

/**
 * Project one meeting row into its list card.
 *
 * Every notes-derived field comes from the post-call notes or is empty: a call
 * whose pipeline is still running shows the shimmer "Writing notes" pill with a
 * blank summary line until the authoritative notes land.
 */
export function toListItem(row: MeetingListRow): MeetingListItem {
  const notes = row.notes;
  return {
    id: row.id,
    // The notes' own title outranks the placeholder the row was created with —
    // a finished call reads by what it was about, not by when it started.
    title: notes?.title ?? row.title,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    notes_status: row.notesStatus,
    tldr: notes?.tldr ?? null,
    conversation_type: notes?.conversationType ?? null,
    action_item_count: notes?.actionItems.length ?? 0,
    has_follow_up: row.hasFollowUp,
  };
}

/** Project a whole page. Order is the reader's; this pass never re-sorts. */
export function toListItems(
  rows: readonly MeetingListRow[],
): MeetingListItem[] {
  return rows.map(toListItem);
}
