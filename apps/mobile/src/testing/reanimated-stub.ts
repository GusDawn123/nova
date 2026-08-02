import { useRef } from 'react';
import { View } from 'react-native';
import { vi } from 'vitest';

/**
 * The shared Reanimated stub for the mobile suites.
 *
 * ---------------------------------------------------------------------------
 * Why Reanimated is mocked at all
 * ---------------------------------------------------------------------------
 * Its web build reaches react-native-web's style compiler through `require()`, which
 * exists under Metro and not under vite; the call fails silently there and the first
 * prop update on a late-mounting animated view throws inside the library. So the real
 * package cannot drive a DOM in this suite whatever we do, and pretending otherwise
 * would only buy a crash.
 *
 * The stub keeps the parts our components actually depend on — a shared value, a
 * style updater that RUNS (so a broken transform still fails here), and `withRepeat`
 * as a spy, which is what makes "no loop starts under reduced motion" an assertion
 * rather than an inference.
 *
 * What that leaves unproven: that the sweep travels, the arc turns, and the caret
 * blinks on a device. Those are simulator checks — the same bargain every visual
 * assertion in this suite makes.
 *
 * ---------------------------------------------------------------------------
 * Using it
 * ---------------------------------------------------------------------------
 * `vi.mock` factories are hoisted above every import, so the stub has to be reached
 * through a dynamic import inside the factory. The static import of this module in
 * the test body resolves to the SAME instance, which is what lets a test assert on
 * {@link reanimatedSpies}:
 *
 * ```ts
 * import { reanimatedSpies } from '@/testing/reanimated-stub';
 *
 * vi.mock('react-native-reanimated', async () => {
 *   const { reanimatedStub } = await import('@/testing/reanimated-stub');
 *   return reanimatedStub();
 * });
 *
 * beforeEach(() => reanimatedSpies.withRepeat.mockClear());
 * ```
 *
 * The spies are MODULE-level (a `vi.mock` factory cannot close over test-local
 * state), so a suite that asserts on them must clear them per test.
 */

/**
 * The stubbed animation calls worth watching.
 *
 * `withRepeat` is the one that matters most: an infinite loop is exactly what
 * reduced motion must not start. `withSequence` covers the one-shot animations a
 * loop spy cannot see — the thinking word's 220ms flick on each swap is a sequence,
 * not a repeat, and reduced motion has to suppress it while the word underneath
 * keeps advancing.
 */
export const reanimatedSpies = {
  withRepeat: vi.fn((value: unknown) => value),
  withSequence: vi.fn((...steps: unknown[]) => steps[steps.length - 1]),
};

/** Easing curves are irrelevant without a running clock — every one is identity. */
const passThroughEasing = (value: number): number => value;

/** The module shape `vi.mock('react-native-reanimated', …)` should return. */
export function reanimatedStub(): Record<string, unknown> {
  return {
    default: { View },
    Easing: {
      linear: passThroughEasing,
      ease: passThroughEasing,
      bezier: () => passThroughEasing,
      inOut: () => passThroughEasing,
    },
    // Identity across renders, like the real one: components put it in effect
    // dependency arrays.
    useSharedValue: <T,>(initial: T) => useRef({ value: initial }).current,
    // Run the updater for real, so a style function that throws or returns nonsense
    // is caught here rather than on a device.
    useAnimatedStyle: (updater: () => unknown) => updater(),
    withRepeat: reanimatedSpies.withRepeat,
    withTiming: (toValue: number) => toValue,
    withDelay: (_delayMs: number, animated: unknown) => animated,
    withSequence: reanimatedSpies.withSequence,
  };
}
