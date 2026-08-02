import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';

import { useReducedMotion } from '@/design/motion';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  eyebrowStyle,
  type Palette,
} from '@/design/tokens';
import { StreamingText } from '@/features/stream/streaming-text';
import { ThinkingIndicator } from '@/features/stream/thinking-indicator';

/**
 * One answer in the copilot history — the card this whole product exists to draw
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4, §6).
 *
 * SOFT, not chamfered: it is read, not pressed (spec §3). The newest card takes a
 * full-ink 1.5pt border and the ink wash; the ones above it drop to a hairline, so
 * the eye lands on the sentence the user is about to say without a second colour or
 * a second size being spent on it.
 *
 * ---------------------------------------------------------------------------
 * The handoff is CARET-FIRST
 * ---------------------------------------------------------------------------
 * While nothing has arrived, the card holds the thinking indicator: a word cycling
 * over three bars, which is the SHAPE of the answer about to be written there. The
 * instant the first delta lands, `StreamingText` mounts and its caret appears — and
 * only then do the bars fade out, over ~240ms, from here (spec §6 gives the exit to
 * the parent: this is the thing that knows the stream started).
 *
 * Unmounting the indicator on the same commit would leave one frame with neither a
 * caret nor a cycling word, and the answer would read as having restarted rather
 * than started. So the two overlap by design, and the test that pins it asserts both
 * are on screen in the same commit.
 */

/** The bars' exit. Spec §6's ~240ms, and the timer that unmounts them. */
export const HANDOFF_MS = 240;

/** Where the card is in the wait → writing transition. */
type Handoff = 'thinking' | 'handoff' | 'written';

/** The exit fade. Nothing enters — the indicator is already there when this arms. */
function useHandoffFade(exiting: boolean): AnimatedStyle<ViewStyle> {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = exiting
      ? withTiming(0, { duration: HANDOFF_MS })
      : withTiming(1, { duration: 0 });
  }, [exiting, opacity]);

  // Explicit deps rather than the Babel plugin's inference: Reanimated requires one
  // or the other, and only this form also renders where the plugin does not run.
  return useAnimatedStyle(() => ({ opacity: opacity.value }), [opacity]);
}

export interface AnswerCardProps {
  readonly palette: Palette;
  /** The user's own words that shaped this answer, or null when nobody steered it. */
  readonly steer: string | null;
  /** The accumulated answer so far. Empty means it has not started. */
  readonly text: string;
  /** Upstream is still sending. The caret's disappearance is the done signal. */
  readonly streaming: boolean;
  /** The bottom card — the one being said now. */
  readonly newest: boolean;
}

export function AnswerCard({
  palette,
  steer,
  text,
  streaming,
  newest,
}: AnswerCardProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const hasText = text !== '';

  // Prop-derived state, adjusted DURING RENDER — React's documented shape for it
  // (and what this repo's `set-state-in-effect` lint leaves as the only option).
  // A card that mounts with text already (scrolled-back history) is born written.
  const [phase, setPhase] = useState<Handoff>(hasText ? 'written' : 'thinking');
  const [seenText, setSeenText] = useState(hasText);

  if (seenText !== hasText) {
    setSeenText(hasText);
    // Reduced motion cuts rather than fades (spec §6): the bars go on the same
    // commit the caret lands, because a 240ms overlap IS the animation.
    if (hasText && phase === 'thinking') setPhase(reduced ? 'written' : 'handoff');
  }

  const fade = useHandoffFade(phase === 'handoff');

  useEffect(() => {
    if (phase !== 'handoff') return;

    const done = setTimeout(() => {
      setPhase('written');
    }, HANDOFF_MS);

    return () => {
      clearTimeout(done);
    };
  }, [phase]);

  return (
    <View
      testID="answer-card"
      style={[
        styles.card,
        newest
          ? {
              borderColor: palette.ink,
              borderWidth: NEWEST_BORDER_WIDTH,
              backgroundColor: palette.inkFill,
            }
          : {
              borderColor: palette.inkHairline,
              borderWidth: StyleSheet.hairlineWidth,
            },
      ]}
    >
      {steer === null ? null : (
        <Text
          testID="steer-chip"
          style={[
            styles.chip,
            { backgroundColor: palette.ink, color: palette.onInk },
          ]}
        >
          {steer}
        </Text>
      )}

      <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
        {phase === 'thinking' ? '◆ NOVA' : '◆ NOVA · SAY THIS'}
      </Text>

      {phase === 'written' ? null : (
        // The cycling word is the only thing on screen saying what she is doing, so
        // it is announced. Polite, not assertive: it must never cut across the
        // answer a screen reader is already reading out.
        <Animated.View
          testID="answer-thinking"
          accessibilityLiveRegion="polite"
          style={fade}
        >
          <ThinkingIndicator color={palette.ink} fillColor={palette.inkFill} />
        </Animated.View>
      )}

      {hasText ? (
        // NO fontSize override: `StreamingText`'s caret is frozen at `FontSize.body`
        // and would sit at the wrong height against any other size. Line height is
        // safe — it moves the line, not the glyphs.
        <StreamingText
          text={text}
          done={!streaming}
          color={palette.ink}
          style={styles.body}
        />
      ) : null}
    </View>
  );
}

/** The newest card's border. Spec §4's 1.5px — heavier than a hairline, on purpose. */
const NEWEST_BORDER_WIDTH = 1.5;

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.soft,
    padding: Space.lg,
    gap: Space.md,
  },
  // The user's own words, right-aligned and tailed at the corner nearest the answer
  // they shaped (spec §4: 14/14/3/14). Mono, because it echoes what they typed into
  // a mono field.
  chip: {
    alignSelf: 'flex-end',
    maxWidth: '78%',
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    lineHeight: FontSize.monoSm * 1.5,
    paddingVertical: Space.xs2,
    paddingHorizontal: Space.md,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 3,
    borderBottomLeftRadius: 14,
    overflow: 'hidden',
  },
  eyebrow: eyebrowStyle,
  body: { lineHeight: FontSize.body * 1.5 },
});
