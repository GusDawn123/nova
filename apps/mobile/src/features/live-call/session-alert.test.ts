import { describe, expect, it } from 'vitest';

import { liveAlertFor } from './session-alert';

/**
 * What the screen does with `useLiveSession.errorMessage`.
 *
 * The hook flattens every typed server error into `"<code>: <message>"`, which is
 * the only channel the screen has for telling a spent quota — a full-screen, plain,
 * retry-less card — from every other interruption, which is one mono line under the
 * HUD rail and a session that carries on.
 *
 * The code is parsed against the wire's closed set rather than matched as a
 * substring: an unrecognised prefix is somebody's message text, not a state.
 */

describe('liveAlertFor', () => {
  it('is silent when nothing has gone wrong', () => {
    expect(liveAlertFor(null)).toBeNull();
  });

  it('reads a spent quota as its own state', () => {
    expect(
      liveAlertFor('quota_exceeded: stt quota exhausted for the current period'),
    ).toEqual({ kind: 'quota' });
  });

  it('says everything else in one line, in the server’s words', () => {
    expect(liveAlertFor('internal: the conductor fell over')).toEqual({
      kind: 'banner',
      text: 'the conductor fell over',
    });
  });

  it('keeps a message that carries no wire code whole', () => {
    // The transport's own failures ("connection error — is the server running?")
    // are not typed events; dropping their first colon-separated word would eat
    // the sentence.
    expect(liveAlertFor('connection error — is the server running?')).toEqual({
      kind: 'banner',
      text: 'connection error — is the server running?',
    });
  });

  it('does not read a quota out of prose', () => {
    expect(liveAlertFor('the word quota_exceeded appeared in a sentence')).toEqual(
      {
        kind: 'banner',
        text: 'the word quota_exceeded appeared in a sentence',
      },
    );
  });
});
