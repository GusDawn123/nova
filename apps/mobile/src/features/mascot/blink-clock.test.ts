import { describe, expect, it } from 'vitest';

import { createBlinkClock } from './blink-clock';

/**
 * The blink scheduler
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7: "Randomized clock: 2-6s
 * intervals, ~140ms closes, occasional double-blink").
 *
 * The clock is pure so that the RANDOMNESS is testable and the component is not. Every
 * number here is exact rather than a range: a scheduler that is "roughly right" is a
 * scheduler nobody can tell has drifted.
 *
 * `rng` is a sequence, not a value, and the ORDER it is consumed in is part of the
 * contract — swap the two draws and every interval still looks plausible while the
 * double-blink rate silently changes. Hence the two asymmetric-sequence tests below.
 */

/** An `rng` that walks a fixed list, then repeats it — deterministic and inspectable. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value ?? 0;
  };
}

describe('createBlinkClock', () => {
  it('turns a midpoint draw into a midpoint interval and no double', () => {
    const clock = createBlinkClock(() => 0.5);

    expect(clock.next()).toEqual({ delayMs: 4000, double: false });
  });

  it('turns a high draw into a long interval AND a double blink', () => {
    // 2000 + 0.9 * 4000 = 5600, and 0.9 clears the double threshold.
    const clock = createBlinkClock(() => 0.9);

    expect(clock.next()).toEqual({ delayMs: 5600, double: true });
  });

  it('spans exactly 2000-6000ms across the range of the generator', () => {
    // The generator's range is [0, 1), so the top of the interval is approached and
    // then ROUNDED onto 6000 — whole milliseconds are what a timer can act on.
    const clock = createBlinkClock(sequence([0, 0, 0.999999, 0]));

    expect(clock.next().delayMs).toBe(2000);
    expect(clock.next().delayMs).toBe(6000);
  });

  it('doubles at 0.75 and not a hair below', () => {
    // The threshold is INCLUSIVE, which is what makes "~25% of blinks" true for a
    // uniform generator over [0, 1).
    const clock = createBlinkClock(sequence([0.5, 0.75, 0.5, 0.7499999]));

    expect(clock.next().double).toBe(true);
    expect(clock.next().double).toBe(false);
  });

  it('draws the interval first and the double second', () => {
    // Same two numbers, opposite order: if the clock read them the other way round
    // both of these would still pass individually, so they are asserted as a pair.
    const long = createBlinkClock(sequence([0.9, 0.1]));
    const short = createBlinkClock(sequence([0.1, 0.9]));

    expect(long.next()).toEqual({ delayMs: 5600, double: false });
    expect(short.next()).toEqual({ delayMs: 2400, double: true });
  });

  it('is deterministic — same sequence in, same events out', () => {
    const draws = [0.1, 0.8, 0.42, 0.99, 0.5, 0.5, 0.77, 0.03];
    const a = createBlinkClock(sequence(draws));
    const b = createBlinkClock(sequence(draws));

    const from = (clock: { next: () => unknown }): unknown[] =>
      Array.from({ length: 8 }, () => clock.next());

    expect(from(a)).toEqual(from(b));
  });

  it('keeps every event inside the contract on the real generator', () => {
    // The default `rng` is `Math.random`; this is the only test that runs it, and it
    // asserts the envelope rather than any particular value.
    const clock = createBlinkClock();

    for (let i = 0; i < 500; i += 1) {
      const event = clock.next();
      expect(event.delayMs).toBeGreaterThanOrEqual(2000);
      expect(event.delayMs).toBeLessThanOrEqual(6000);
      expect(Number.isInteger(event.delayMs)).toBe(true);
      expect(typeof event.double).toBe('boolean');
    }
  });
});
