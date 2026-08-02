/**
 * The blink clock — when she next closes her eyes
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7: "Randomized clock: 2-6s
 * intervals, ~140ms closes, occasional double-blink").
 *
 * PURE, and separate from the component that consumes it, for one reason: a blink
 * that fires on a fixed cadence stops reading as a living thing within about three
 * cycles, and randomness is exactly the part a rendering test cannot pin down. Lift it
 * out and the schedule becomes ordinary arithmetic over an injected generator —
 * `MascotStage` is then only responsible for turning an event into motion.
 *
 * The clock says WHEN and WHETHER, never how long the close lasts: the shape of a
 * blink belongs to the timeline in `mascot-glitch.ts`, which is what keeps the eyes
 * and the hologram tear on the same instant.
 */

/** One scheduled blink: how long to wait, and whether it stutters twice. */
export interface BlinkEvent {
  /** Delay from now until the eyes start to close, in ms. */
  delayMs: number;
  /** A double blink — two closes in quick succession — rather than a single. */
  double: boolean;
}

/** Spec §7: intervals run 2-6 seconds. */
const MIN_INTERVAL_MS = 2000;
const MAX_INTERVAL_MS = 6000;

/**
 * A draw at or above this doubles the blink — so roughly a quarter of them do, which
 * is the spec's "occasional". Inclusive, because a uniform generator over [0, 1)
 * otherwise lands fractionally under a quarter.
 */
const DOUBLE_THRESHOLD = 0.75;

export interface BlinkClock {
  /** The next event. Consumes exactly two numbers from the generator, in that order. */
  next: () => BlinkEvent;
}

/**
 * @param rng values in [0, 1). Defaults to `Math.random`; tests pass a sequence, which
 *   is what makes the schedule deterministic and therefore assertable.
 */
export function createBlinkClock(rng: () => number = Math.random): BlinkClock {
  return {
    next(): BlinkEvent {
      // Interval FIRST, double second. Both draws happen on every call whatever the
      // first one returns, so a caller replaying a recorded sequence gets the same
      // events back — short-circuiting the second draw would desynchronise it.
      const interval = rng();
      const stutter = rng();

      return {
        // Whole milliseconds: the consumer hands this straight to `setTimeout`, and a
        // fractional timer is a number nobody can act on.
        delayMs: Math.round(
          MIN_INTERVAL_MS + interval * (MAX_INTERVAL_MS - MIN_INTERVAL_MS),
        ),
        double: stutter >= DOUBLE_THRESHOLD,
      };
    },
  };
}
