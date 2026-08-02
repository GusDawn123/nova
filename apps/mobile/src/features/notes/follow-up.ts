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
  /** `gone` = the meeting itself is missing or soft-deleted (the 404). */
  readonly kind: 'notes_not_ready' | 'quota' | 'unavailable' | 'gone' | 'failed';
  /** Whether to offer a retry affordance at all. */
  readonly canRetry: boolean;
  /** Whether the three tone buttons should be inert. */
  readonly tonesDisabled: boolean;
};

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
  gone: {
    title: 'This call is gone',
    body: 'The call this draft belonged to is no longer in your archive, so there is nothing left to write from.',
  },
  quota: {
    title: 'Out of drafts for now',
    body: 'This month’s follow-up drafts are used up. The notes above stay yours.',
  },
  unavailable: {
    title: 'Nova is resting',
    body: 'Drafting is paused for the moment. The call and its notes are untouched.',
  },
  failed: {
    title: 'The draft didn’t come out',
    body: 'Something went wrong while writing the follow-up for this call.',
  },
};
