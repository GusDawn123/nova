import { useEffect, useState } from 'react';
import { AccessibilityInfo, type ViewStyle } from 'react-native';
import {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';

/**
 * Motion, transcribed from the mock's `@keyframes` (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §7.1). Durations and curves are copied exactly; the
 * implementation is Reanimated rather than CSS, so this is a reimplementation and
 * not a port.
 *
 * ---------------------------------------------------------------------------
 * The opacity trap
 * ---------------------------------------------------------------------------
 * The mock's two entrance keyframes both start at `opacity: 0`:
 *
 *   riseIn { from { opacity:0; transform:translateY(7px); filter:blur(5px) } }
 *   cardIn { from { opacity:0; transform:translateY(14px) scale(.985) } }
 *
 * Per the SDK 57 docs, setting opacity to 0 on a `GlassView` **or any of its parent
 * views** stops the glass rendering AT ALL — and it does not come back when opacity
 * returns to 1. So a card that entered with a naive opacity fade would simply never
 * show its glass, with nothing in the logs to say why.
 *
 * Hence two variants of each entrance:
 *   - {@link useRiseIn} / {@link useCardIn} — opacity + transform, for plain content
 *     (text, bullets, rows). This is the mock's exact feel.
 *   - {@link useCardInTransformOnly} — transform only, for anything wrapping glass.
 *     It starts at full opacity and slides/scales in. Slightly less soft; the only
 *     option that actually renders.
 *
 * `filter: blur()` has no RN equivalent and is dropped — it is a 5px blur over
 * 500ms on text that is also moving, and its absence is not visible.
 *
 * ---------------------------------------------------------------------------
 * Reduced motion
 * ---------------------------------------------------------------------------
 * Every looping animation here is decorative: the record dot, the listening dots,
 * the shimmer, the orb rings, the star. None of them carries information that is
 * lost when stilled — the states they decorate are all also stated in text. So
 * {@link useReducedMotion} resolves once and the hooks settle straight to their
 * resting value instead of looping.
 */

/** The mock's shared entrance curve: `cubic-bezier(.2,.8,.2,1)`. */
export const ENTRANCE_EASING = Easing.bezier(0.2, 0.8, 0.2, 1);

/** Durations, in ms, exactly as the mock declares them. */
export const Duration = {
  riseIn: 500,
  cardIn: 500,
  /** Per-word stagger for the streaming text effect (mock: 0.05s). */
  wordStagger: 50,
  /** Suggestion bullet stagger (mock: 0.5s between lines). */
  lineStagger: 500,
  recDot: 1600,
  dotWave: 1150,
  shimmer: 1300,
  ring: 3000,
  starPulse: 1500,
  caret: 1000,
  bar: 900,
} as const;

/**
 * Whether the OS asks for reduced motion. Resolves asynchronously, so it starts
 * `false` and flips if the setting is on — a decorative animation running for one
 * frame before settling is not worth blocking first paint over.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced,
    );
    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  return reduced;
}

/**
 * `riseIn` — content arriving: fade up 7px over 500ms.
 *
 * @param delayMs stagger offset; the word-by-word effect is this hook per word.
 */
export function useRiseIn(delayMs = 0): AnimatedStyle<ViewStyle> {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withTiming(1, { duration: Duration.riseIn, easing: ENTRANCE_EASING }),
    );
  }, [delayMs, progress, reduced]);

  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: 7 * (1 - progress.value) }],
  }));
}

/** `cardIn` — a card arriving: fade up 14px with a 0.985 → 1 scale. */
export function useCardIn(delayMs = 0): AnimatedStyle<ViewStyle> {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withTiming(1, { duration: Duration.cardIn, easing: ENTRANCE_EASING }),
    );
  }, [delayMs, progress, reduced]);

  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: 14 * (1 - progress.value) },
      { scale: 0.985 + 0.015 * progress.value },
    ],
  }));
}

/**
 * `cardIn` WITHOUT the opacity ramp — for anything that wraps a `GlassView`.
 *
 * Starts fully opaque and slides/scales in. Use this on glass; use {@link useCardIn}
 * on everything else. See the opacity-trap note at the top of this file.
 */
export function useCardInTransformOnly(delayMs = 0): AnimatedStyle<ViewStyle> {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withTiming(1, { duration: Duration.cardIn, easing: ENTRANCE_EASING }),
    );
  }, [delayMs, progress, reduced]);

  return useAnimatedStyle(() => ({
    transform: [
      { translateY: 14 * (1 - progress.value) },
      { scale: 0.985 + 0.015 * progress.value },
    ],
  }));
}

/**
 * `recDot` — the recording pulse: opacity 1 → 0.35 and scale 1 → 0.8, alternating.
 *
 * @param running paused when the mock pauses it (`animation-play-state`).
 */
export function usePulse(running = true): AnimatedStyle<ViewStyle> {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced || !running) {
      progress.value = withTiming(0, { duration: 200 });
      return;
    }
    progress.value = withRepeat(
      withTiming(1, { duration: Duration.recDot / 2, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [progress, reduced, running]);

  return useAnimatedStyle(() => ({
    opacity: 1 - 0.65 * progress.value,
    transform: [{ scale: 1 - 0.2 * progress.value }],
  }));
}

/**
 * `dotWave` — the three listening dots: each rises 4px and brightens, staggered.
 *
 * @param index 0-2; drives the mock's 0.18s stagger.
 */
export function useDotWave(index: number, running = true): AnimatedStyle<ViewStyle> {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced || !running) {
      progress.value = withTiming(0, { duration: 200 });
      return;
    }
    progress.value = withDelay(
      index * 180,
      withRepeat(
        withTiming(1, {
          duration: Duration.dotWave / 2,
          easing: Easing.inOut(Easing.ease),
        }),
        -1,
        true,
      ),
    );
  }, [index, progress, reduced, running]);

  return useAnimatedStyle(() => ({
    opacity: 0.35 + 0.65 * progress.value,
    transform: [{ translateY: -4 * progress.value }],
  }));
}

/**
 * `shimmerMove` — the loading skeleton sweep and the "Writing notes" pill.
 *
 * Returns a translateX in multiples of the element's width; the consumer supplies
 * the width so the gradient travels the right distance.
 */
export function useShimmer(width: number): AnimatedStyle<ViewStyle> {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      progress.value = 0.5;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, { duration: Duration.shimmer, easing: Easing.linear }),
      -1,
      false,
    );
  }, [progress, reduced]);

  return useAnimatedStyle(() => ({
    // Mock: background-position -160% → 260%.
    transform: [{ translateX: width * (-1.6 + 4.2 * progress.value) }],
  }));
}

/**
 * `caret` — the partial-transcript cursor: a hard on/off blink, not a fade.
 *
 * The mock uses `steps(1)`, so a timing curve here would be wrong; the sequence of
 * two instant `withTiming(…, {duration: 0})` steps reproduces the square wave.
 */
export function useCaret(): AnimatedStyle<ViewStyle> {
  const on = useSharedValue(1);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      on.value = 1;
      return;
    }
    on.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 0 }),
        withDelay(Duration.caret * 0.5, withTiming(0.1, { duration: 0 })),
        withDelay(Duration.caret * 0.5, withTiming(1, { duration: 0 })),
      ),
      -1,
      false,
    );
  }, [on, reduced]);

  return useAnimatedStyle(() => ({ opacity: on.value }));
}

/** Per-word entrance delay for the streaming text effect (mock: `i * 0.05s`). */
export function wordDelay(index: number): number {
  return index * Duration.wordStagger;
}
