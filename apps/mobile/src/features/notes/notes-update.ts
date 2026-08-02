import type { MeetingNotes } from "@nova/shared";

/**
 * The `notes.update` revision rule (Phase 8, `packages/shared/src/live.ts` §notes;
 * Phase 8.5 §5.3). PURE — the one piece of live-notes handling that can actually be
 * wrong, extracted so it is testable without a socket.
 *
 * The protocol documents a CLIENT RULE that had no implementation until now, because
 * nothing on the client consumed the event: **drop any update whose `rev` is ≤ the
 * last one seen.** Revisions are monotonic per meeting, and the server may re-emit
 * across a reconnect, so without the guard a late-delivered older payload would
 * overwrite newer notes and the user would watch their notes go backwards.
 *
 * Equal revs are dropped too, not just lower ones: a re-emitted rev carries the same
 * state by definition, so applying it can only cost a re-render — and treating `=` as
 * "newer" would make the guard depend on delivery order, which is the thing it exists
 * to be independent of.
 */

/** What the client holds for one meeting's live notes. */
export interface LiveNotesState {
  readonly notes: MeetingNotes | null;
  /** The highest rev applied so far; null before the first update. */
  readonly rev: number | null;
  /**
   * Set when an update landed that the user has not seen — drives the unread dot on
   * the hidden tab (§5.1). Cleared by {@link markLiveNotesSeen}, never by an update.
   */
  readonly hasUnseen: boolean;
}

export const emptyLiveNotes: LiveNotesState = {
  notes: null,
  rev: null,
  hasUnseen: false,
};

/**
 * Apply an incoming `notes.update`, or return the state unchanged when the rule
 * rejects it.
 *
 * Returns the SAME object reference when nothing was applied, so a `useState` setter
 * fed by this performs no re-render on a dropped update.
 *
 * @param visible whether the live-notes panel is on screen right now. An update that
 *   lands while the user is looking at the transcript tab is what the unread dot is
 *   for; one that lands while they are watching has already been seen.
 */
export function applyNotesUpdate(
  state: LiveNotesState,
  incoming: { notes: MeetingNotes; rev: number },
  visible: boolean,
): LiveNotesState {
  if (state.rev !== null && incoming.rev <= state.rev) return state;
  return {
    notes: incoming.notes,
    rev: incoming.rev,
    hasUnseen: visible ? false : true,
  };
}

/** Clear the unread flag — the panel became visible. */
export function markLiveNotesSeen(state: LiveNotesState): LiveNotesState {
  return state.hasUnseen ? { ...state, hasUnseen: false } : state;
}
