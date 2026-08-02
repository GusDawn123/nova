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
 * The `tldr` ladder is `notes → liveNotes → null`, mirroring the notes read model's
 * "prefer authoritative, fall back to live" rule. It matters most for the case the
 * design leans on: a call whose post-call pipeline is still running shows the
 * shimmer "Writing notes" pill, and WITHOUT this fallback its card would have a
 * blank summary line — the one moment the user is most curious about it. The live
 * fold has already produced a real tldr by then, so we show it.
 *
 * `conversationType` and `actionItemCount` deliberately do NOT take that fallback:
 * both are classification-grade claims that read as settled, and the live fold
 * revises them as the call goes on. A count that ticks 2 → 4 → 3 under a "Writing
 * notes" badge invites the user to trust a number that is still moving. The summary
 * line is prose and reads as provisional; a chip does not.
 */
export function toListItem(row: MeetingListRow): MeetingListItem {
  const notes = row.notes;
  return {
    id: row.id,
    title: row.title,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    notes_status: row.notesStatus,
    tldr: notes?.tldr ?? row.liveNotes?.tldr ?? null,
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
