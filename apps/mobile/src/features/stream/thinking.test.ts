import { describe, expect, it } from 'vitest';

import {
  THINKING_BEAT_MS,
  THINKING_CYCLE_MS,
  THINKING_WORDS,
  thinkingWordAt,
} from './thinking';

/**
 * The thinking cadence
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6).
 *
 * The schedule is pure and therefore the one part of this state worth pinning
 * exactly: which word is on screen at t, where the boundaries fall, and what happens
 * to a wait that outlives a full cycle. The flick and the sweeps are device checks.
 */

describe('thinkingWordAt', () => {
  it('opens on LISTENING and walks the arc a beat at a time', () => {
    expect(thinkingWordAt(0)).toBe('LISTENING');
    expect(thinkingWordAt(900)).toBe('READING THE MOMENT');
    expect(thinkingWordAt(2500)).toBe('COMPOSING');
  });

  it('changes word exactly on the beat, not a millisecond either side', () => {
    // The swap is a 220ms flick, so a boundary that drifts is visible as the word
    // and the flick coming apart.
    expect(thinkingWordAt(THINKING_BEAT_MS - 1)).toBe('LISTENING');
    expect(thinkingWordAt(THINKING_BEAT_MS)).toBe('READING THE MOMENT');
    expect(thinkingWordAt(2 * THINKING_BEAT_MS - 1)).toBe('READING THE MOMENT');
    expect(thinkingWordAt(2 * THINKING_BEAT_MS)).toBe('COMPOSING');
  });

  it('rests on COMPOSING for a second beat before it goes round again', () => {
    // Three words at 820ms is 2460ms, and plenty of waits run past that. Snapping
    // COMPOSING → LISTENING the instant she gets to composing reads as the work
    // being thrown away; holding the last state and then restarting does not.
    expect(thinkingWordAt(3 * THINKING_BEAT_MS)).toBe('COMPOSING');
    expect(thinkingWordAt(4 * THINKING_BEAT_MS - 1)).toBe('COMPOSING');
    expect(thinkingWordAt(2460 + 820)).toBe('LISTENING');
  });

  it('wraps forever rather than running off the end of the list', () => {
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const base = cycle * THINKING_CYCLE_MS;
      expect(thinkingWordAt(base)).toBe('LISTENING');
      expect(thinkingWordAt(base + THINKING_BEAT_MS)).toBe('READING THE MOMENT');
      expect(thinkingWordAt(base + 2 * THINKING_BEAT_MS)).toBe('COMPOSING');
      expect(thinkingWordAt(base + 3 * THINKING_BEAT_MS)).toBe('COMPOSING');
    }
  });

  it('only ever says one of the three words', () => {
    const words: string[] = [...THINKING_WORDS];
    for (let elapsed = 0; elapsed < 20000; elapsed += 37) {
      expect(words).toContain(thinkingWordAt(elapsed));
    }
  });

  it('shows the first word for a clock that reads as negative or broken', () => {
    // A caller subtracting a start timestamp can hand this a negative or a NaN
    // across a clock adjustment. The indicator has no error state — it opens where
    // it would have opened.
    expect(thinkingWordAt(-1)).toBe('LISTENING');
    expect(thinkingWordAt(-100000)).toBe('LISTENING');
    expect(thinkingWordAt(Number.NaN)).toBe('LISTENING');
    expect(thinkingWordAt(Number.POSITIVE_INFINITY)).toBe('LISTENING');
  });
});

describe('THINKING_WORDS', () => {
  it('is the spec arc, in order', () => {
    expect([...THINKING_WORDS]).toEqual([
      'LISTENING',
      'READING THE MOMENT',
      'COMPOSING',
    ]);
  });

  it('beats at the spec cadence', () => {
    expect(THINKING_BEAT_MS).toBe(820);
    // Four beats, because COMPOSING holds two of them.
    expect(THINKING_CYCLE_MS).toBe(4 * THINKING_BEAT_MS);
  });
});
