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
