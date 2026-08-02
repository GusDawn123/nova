import { describe, expect, it } from 'vitest';

import { FOLLOW_UP_FAILURE_COPY, mapFollowUpFailure } from './follow-up';

/**
 * The follow-up failure map (§8). Every row of that table is a different thing to
 * SAY to the user and a different answer to "may they try again", so the mapping is
 * pure and tested rather than inlined in the panel as a chain of ternaries.
 */

describe('mapFollowUpFailure', () => {
  it('reads 409 notes_not_ready as a wait, not a failure', () => {
    const state = mapFollowUpFailure(409, 'notes_not_ready');

    expect(state.kind).toBe('notes_not_ready');
    expect(state.tonesDisabled).toBe(true);
    // No retry affordance: the notes land on their own.
    expect(state.canRetry).toBe(false);
  });

  it('offers no retry on a 429 quota block', () => {
    // A retry loop against a quota wall burns the user's taps and our tokens.
    const state = mapFollowUpFailure(429, 'quota_exceeded');

    expect(state.kind).toBe('quota');
    expect(state.canRetry).toBe(false);
  });

  it('reads a 429 off the status alone, whatever code rides with it', () => {
    // The mapper never inspects the code on a 429; a body without one must map the
    // same way rather than falling through to the retryable bucket.
    expect(mapFollowUpFailure(429, undefined)).toEqual(
      mapFollowUpFailure(429, 'quota_exceeded'),
    );
  });

  it('offers no retry once the meeting itself is gone', () => {
    // A 404 is the meeting being deleted, not a hiccup: retrying can only 404 again.
    const state = mapFollowUpFailure(404, undefined);

    expect(state.kind).toBe('gone');
    expect(state.canRetry).toBe(false);
    expect(state.tonesDisabled).toBe(true);
  });

  it('blames the service, not the user, on a 503 daily cap', () => {
    const state = mapFollowUpFailure(503, 'daily_cap_reached');

    expect(state.kind).toBe('unavailable');
    expect(state.canRetry).toBe(true);
  });

  it('treats an unknown failure as retryable rather than fatal', () => {
    const state = mapFollowUpFailure(500, undefined);

    expect(state.kind).toBe('failed');
    expect(state.canRetry).toBe(true);
  });

  it('does not disable the tone buttons for a transient failure', () => {
    // Only notes_not_ready is about the notes; the rest are about this attempt.
    expect(mapFollowUpFailure(503, 'daily_cap_reached').tonesDisabled).toBe(false);
    expect(mapFollowUpFailure(500, undefined).tonesDisabled).toBe(false);
  });

  it('keeps a 409 with an unexpected code retryable instead of silently waiting', () => {
    // Guessing "not ready" from the status alone would disable the tone buttons on
    // a 409 that means something else entirely.
    const state = mapFollowUpFailure(409, 'already_running');

    expect(state.kind).toBe('failed');
    expect(state.tonesDisabled).toBe(false);
  });
});

describe('FOLLOW_UP_FAILURE_COPY', () => {
  it('has a sentence for every kind the mapping can produce', () => {
    const kinds = [
      mapFollowUpFailure(409, 'notes_not_ready'),
      mapFollowUpFailure(404, undefined),
      mapFollowUpFailure(429, undefined),
      mapFollowUpFailure(503, undefined),
      mapFollowUpFailure(500, undefined),
    ].map((failure) => failure.kind);

    for (const kind of kinds) {
      expect(FOLLOW_UP_FAILURE_COPY[kind].title.length).toBeGreaterThan(0);
      expect(FOLLOW_UP_FAILURE_COPY[kind].body.length).toBeGreaterThan(0);
    }
  });

  it('never words a state as the control that sits under it', () => {
    // The panel draws its own TRY AGAIN key when `canRetry` says so; copy that
    // also says "try again" reads as two buttons to a screen reader.
    for (const copy of Object.values(FOLLOW_UP_FAILURE_COPY)) {
      expect(copy.title).not.toMatch(/try again|retry/i);
    }
  });
});
