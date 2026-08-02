/**
 * Follow-up draft failure mapping (`docs/DESIGN/notes-ui.md` §8).
 *
 * `POST /meetings/:id/follow-up` answers 200 | 409 `notes_not_ready` | 429
 * `quota_exceeded` | 503 `daily_cap_reached` | 404. Those are five different
 * sentences to the user and two different answers to "can they try again", so the
 * decision lives here as data rather than as ternaries inside the panel.
 *
 * The mapping keys off the typed CODE, not the status alone: a 409 also carries
 * `already_running` from the regenerate route's vocabulary, and treating any 409 as
 * "notes aren't ready" would disable the tone buttons on a failure that has nothing
 * to do with the notes.
 */

export type FollowUpFailure = {
  /**
   * `gone` = the meeting itself is missing or soft-deleted (the 404).
   *
   * `no_notes` is the one kind {@link mapFollowUpFailure} never returns: it has no
   * HTTP status because it is read off the MEETING, not off a failed POST — a call
   * whose notes failed, or that predates notes entirely, has nothing to draft from
   * and there is no request left to make. It lives in this union anyway because it
   * is the same question ("why is there no draft, and can that change?") answered
   * from the other direction, and the panel must not have two vocabularies for it.
   */
  readonly kind:
    | 'notes_not_ready'
    | 'quota'
    | 'unavailable'
    | 'gone'
    | 'failed'
    | 'no_notes';
  /** Whether to offer a retry affordance at all. */
  readonly canRetry: boolean;
  /** Whether the three tone buttons should be inert. */
  readonly tonesDisabled: boolean;
};

/**
 * No notes on this call, so no follow-up — the read-side failure.
 *
 * Not retryable and not tone-able: both would offer to re-run a draft against
 * source material that does not exist.
 */
export const NO_NOTES_TO_DRAFT_FROM: FollowUpFailure = {
  kind: 'no_notes',
  canRetry: false,
  tonesDisabled: true,
};

/**
 * The notes have not landed yet — the same wait the POST answers with a 409, reached
 * from the READ side (a meeting whose `notes_status` is queued or processing).
 *
 * Built THROUGH the mapping rather than written out again, so the two roads to this
 * state cannot drift apart, and named here so the detail screen does not have to
 * quote an HTTP status it never received.
 */
export const NOTES_NOT_READY_TO_DRAFT_FROM: FollowUpFailure = mapFollowUpFailure(
  409,
  'notes_not_ready',
);

export function mapFollowUpFailure(
  status: number,
  code: string | undefined,
): FollowUpFailure {
  if (status === 409 && code === 'notes_not_ready') {
    // Not a failure — the notes simply have not landed yet. A retry button would
    // invite the user to hammer a door that opens on its own.
    return { kind: 'notes_not_ready', canRetry: false, tonesDisabled: true };
  }

  if (status === 404) {
    // The meeting is gone or soft-deleted. Nothing to draft from, on this attempt
    // or any later one — so no retry, and the tone buttons lead nowhere either.
    return { kind: 'gone', canRetry: false, tonesDisabled: true };
  }

  if (status === 429) {
    return { kind: 'quota', canRetry: false, tonesDisabled: false };
  }

  if (status === 503) {
    return { kind: 'unavailable', canRetry: true, tonesDisabled: false };
  }

  return { kind: 'failed', canRetry: true, tonesDisabled: false };
}

/**
 * What each kind SAYS. A `Record` keyed by the union, so a sixth failure kind fails
 * to compile here rather than reaching a user as a blank card.
 *
 * The titles state a condition and never name an action: the panel draws its own
 * TRY AGAIN key when {@link FollowUpFailure.canRetry} allows one, and a title that
 * also said "try again" would be announced as a second control that is not there.
 */
export const FOLLOW_UP_FAILURE_COPY: Record<
  FollowUpFailure['kind'],
  { readonly title: string; readonly body: string }
> = {
  notes_not_ready: {
    title: 'The notes come first',
    body: 'A follow-up is written from the notes, so it waits until they land. Nothing to do — it will be here.',
  },
  // Deliberately promises NOTHING. `notes_not_ready` ends "it will be here"; for a
  // call whose notes failed, or one from before Nova wrote any, they will not.
  no_notes: {
    title: 'No notes, so no follow-up',
    body: 'A follow-up is written from the notes, and this call has none to write from. The transcript tab still has every word of it.',
  },
  gone: {
    title: 'This call is gone',
    body: 'The call this draft belonged to is no longer in your archive, so there is nothing left to write from.',
  },
  quota: {
    title: 'Out of drafts for now',
    body: "This month's follow-up drafts are used up. The notes above stay yours.",
  },
  unavailable: {
    title: 'Nova is resting',
    body: 'Drafting is paused for the moment. The call and its notes are untouched.',
  },
  failed: {
    title: "The draft didn't come out",
    body: 'Something went wrong while writing the follow-up for this call.',
  },
};
