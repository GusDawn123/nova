import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';

import { LightSweep } from '@/design/light-sweep';
import { ENTRANCE_EASING, useReducedMotion } from '@/design/motion';
import { FontFamily, FontSize, Space } from '@/design/tokens';

import { THINKING_BEAT_MS, thinkingWordAt } from './thinking';

/**
 * The thinking indicator — "she narrates while the silhouette forms"
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6).
 *
 * A status word cycling in Space Mono over three translucent bars with light
 * travelling along them. The bars are the SHAPE of an answer that has not arrived —
 * ragged lengths, like the paragraph about to be written there — which is why they
 * are three uneven bars rather than a spinner: the eye is already resting where the
 * text will appear.
 *
 * It says nothing about progress, because nothing behind it reports any.
 *
 * ---------------------------------------------------------------------------
 * The word is information; everything else is decoration
 * ---------------------------------------------------------------------------
 * Under reduced motion the flick and the sweeps stop, and the word KEEPS ADVANCING.
 * It is the only thing on screen saying what she is doing, so stilling it would take
 * the meaning away rather than the motion — the bar the rest of `motion.ts` clears
 * ("none of them carries information that is lost when stilled") is exactly the bar
 * this one does not clear. So the beat interval and the flick are separate machinery
 * on purpose: the setting kills the second and never the first.
 *
 * ---------------------------------------------------------------------------
 * The exit belongs to the parent
 * ---------------------------------------------------------------------------
 * Handoff is caret-first (spec §6): the bars fade over ~240ms while the caret lands
 * at the first character's position. That fade is the PARENT's — it is the thing
 * that knows the stream started, and it unmounts this component. Building an exit
 * in here would give the two of them competing opinions about when she is done.
 *
 * No palette is imported: `color` and `fillColor` arrive from the caller, which
 * already knows its theme — the contract `ChamferSurface` and `LightSweep` keep.
 */

/** The bars, top to bottom: the spec's 92/78/45% widths (spec §6). */
export const THINKING_BARS = [
  { width: '92%', sweepMs: 1400 },
  { width: '78%', sweepMs: 1780 },
  { width: '45%', sweepMs: 1150 },
] as const;

/** Bar thickness — a line of text seen out of focus, not a progress track. */
const BAR_HEIGHT = 6;

/** One word swap: out at once, back over 220ms. A flick, not a cross-fade. */
const FLICK_MS = 220;
/** How far the incoming word rises. Small — it flickers in, it does not enter. */
const FLICK_RISE = 5;

/** The uppercase machine voice. Wider than the eyebrow: this one is being read. */
const WORD_LETTER_SPACING = 2.5;

/**
 * The hologram flick — replays whenever `word` changes.
 *
 * Gated the way `useShimmer` in `motion.ts` is: the hook is called unconditionally
 * (Reanimated requires that) and reduced motion is what stops the animation from
 * starting, leaving the word fully drawn and still. It is a `withSequence` rather
 * than a repeat because it fires once per swap — the cycling is the interval's job,
 * not the animation's.
 */
function useWordFlick(word: string, reduced: boolean): AnimatedStyle<ViewStyle> {
  const shown = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      shown.value = 1;
      return;
    }
    shown.value = withSequence(
      withTiming(0, { duration: 0 }),
      withTiming(1, { duration: FLICK_MS, easing: ENTRANCE_EASING }),
    );
  }, [reduced, shown, word]);

  // Explicit deps rather than the Babel plugin's inference: Reanimated requires one
  // or the other, and only this form also renders where the plugin does not run.
  return useAnimatedStyle(
    () => ({
      opacity: shown.value,
      transform: [{ translateY: FLICK_RISE * (1 - shown.value) }],
    }),
    [shown],
  );
}

export interface ThinkingIndicatorProps {
  /** Ink for the word and for the light travelling along the bars. */
  color: string;
  /** The bars' body — `inkFill` at the caller's theme. */
  fillColor: string;
}

export function ThinkingIndicator({
  color,
  fillColor,
}: ThinkingIndicatorProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const [elapsedMs, setElapsedMs] = useState(0);

  // NOT gated on reduced motion — see the header. The beat is counted rather than
  // read off a clock: it drives a word, so a few milliseconds of interval drift over
  // a wait are invisible, and counting is deterministic under a test's fake timers
  // where a wall-clock read is not.
  useEffect(() => {
    const beat = setInterval(() => {
      setElapsedMs((previous) => previous + THINKING_BEAT_MS);
    }, THINKING_BEAT_MS);

    return () => {
      clearInterval(beat);
    };
  }, []);

  const word = thinkingWordAt(elapsedMs);
  const flick = useWordFlick(word, reduced);

  return (
    <View style={styles.root}>
      <Animated.View style={flick}>
        <Text style={[styles.word, { color }]} testID="thinking-word">
          {word}
        </Text>
      </Animated.View>
      <View style={styles.bars}>
        {THINKING_BARS.map((bar) => (
          <View
            key={bar.width}
            style={[styles.bar, { width: bar.width, backgroundColor: fillColor }]}
            testID="thinking-bar"
          >
            {/* The sweep fills the bar rather than sitting under it, so the light
                travels THROUGH the shape instead of underlining it. Its own faint
                rail lands on top of `fillColor`; together they are the bar's body. */}
            <LightSweep
              color={color}
              durationMs={bar.sweepMs}
              height={BAR_HEIGHT}
              style={StyleSheet.absoluteFill}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: Space.md },
  word: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    letterSpacing: WORD_LETTER_SPACING,
    textTransform: 'uppercase',
  },
  bars: { gap: Space.xs2 },
  // Square, not chamfered: the bars are static, and a cut corner would claim they
  // are actionable (spec §3).
  bar: { height: BAR_HEIGHT, overflow: 'hidden' },
});
