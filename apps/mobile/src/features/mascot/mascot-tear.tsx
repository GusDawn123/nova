import { Image } from 'expo-image';
import { useId } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import eyesOpenArt from '../../../assets/mascot/eyes-open.png';
import { SLICE_HEIGHT_RATIO, glitchFrameAt } from './mascot-glitch';

/**
 * The tear — what only exists for a fifth of a second
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7, "her signature").
 *
 * Three layers, split from `mascot-stage.tsx` for size, and exported separately
 * because they are NOT contiguous in the tree: the echoes go BEHIND her, the
 * displaced band goes over her, and the tracking line goes over everything including
 * the scanlines. Collapsing them into one node would put the echoes on top and wash
 * the figure out.
 *
 * All three read the stage's one animated value. They take it as a prop rather than
 * owning it, which is what makes "blink and glitch cannot drift" true by construction
 * — there is no second clock in this file to fall out of step with.
 *
 * None of it renders under reduced motion; the stage makes that decision once.
 */

interface TearProps {
  /** Milliseconds into the current blink event — the stage's one clock. */
  elapsed: SharedValue<number>;
  /** Whether this event is a double blink. */
  doubling: SharedValue<boolean>;
  /** Side of the square figure, in points. */
  size: number;
}

/**
 * The hot echo is the same art with an ink-tinted copy laid over it; the cold one is
 * the same art dimmed. That is how the demo's `brightness(1.6)` / `brightness(0.65)`
 * survives into a runtime with no CSS filters WITHOUT inventing a colour: lifting
 * means moving toward the ink, dimming means letting more of the canvas through
 * (spec §11 — two colours, never a third).
 */
const GHOST_HOT_TINT = 0.6;
const GHOST_COLD_DIM = 0.65;

export function TearGhosts({
  elapsed,
  doubling,
  color,
}: Omit<TearProps, 'size'> & { color: string }): React.JSX.Element {
  const ghostAStyle = useAnimatedStyle(() => {
    const { ghostA } = glitchFrameAt(elapsed.value, doubling.value);
    return {
      opacity: ghostA.opacity,
      transform: [{ translateX: ghostA.translateX }],
    };
  }, [doubling, elapsed]);

  const ghostBStyle = useAnimatedStyle(() => {
    const { ghostB } = glitchFrameAt(elapsed.value, doubling.value);
    return {
      opacity: ghostB.opacity,
      transform: [{ translateX: ghostB.translateX }],
    };
  }, [doubling, elapsed]);

  return (
    <>
      <Animated.View
        style={[StyleSheet.absoluteFill, ghostAStyle]}
        testID="mascot-ghost-a"
      >
        <Image source={eyesOpenArt} style={styles.frame} contentFit="contain" />
        <Image
          source={eyesOpenArt}
          style={[styles.frame, styles.overlay, { opacity: GHOST_HOT_TINT }]}
          contentFit="contain"
          tintColor={color}
        />
      </Animated.View>
      <Animated.View
        style={[StyleSheet.absoluteFill, ghostBStyle]}
        testID="mascot-ghost-b"
      >
        <Image
          source={eyesOpenArt}
          style={[styles.frame, { opacity: GHOST_COLD_DIM }]}
          contentFit="contain"
        />
      </Animated.View>
    </>
  );
}

/**
 * One horizontal band of her, displaced sideways.
 *
 * The band is a WINDOW that moves while the art inside it stays put: the outer view
 * clips, the inner one cancels the same translation. That cuts a strip out of the
 * figure using transforms alone — no animated layout, and no second copy of her drawn
 * out of register underneath.
 */
export function TearSlice({ elapsed, doubling, size }: TearProps): React.JSX.Element {
  const windowStyle = useAnimatedStyle(() => {
    const { slice } = glitchFrameAt(elapsed.value, doubling.value);
    return {
      opacity: slice.opacity,
      transform: [{ translateY: slice.top * size }, { translateX: slice.translateX }],
    };
  }, [doubling, elapsed, size]);

  const artStyle = useAnimatedStyle(() => {
    const { slice } = glitchFrameAt(elapsed.value, doubling.value);
    return { transform: [{ translateY: -slice.top * size }] };
  }, [doubling, elapsed, size]);

  return (
    <Animated.View
      style={[styles.window, { height: size * SLICE_HEIGHT_RATIO }, windowStyle]}
      testID="mascot-slice"
    >
      <Animated.View style={[{ width: size, height: size }, artStyle]}>
        <Image
          source={eyesOpenArt}
          style={{ width: size, height: size }}
          contentFit="contain"
        />
      </Animated.View>
    </Animated.View>
  );
}

/** The tracking bar: a hairline of light, inset from both edges, snapping downward. */
const TRACK_HEIGHT = 2;
const TRACK_INSET_RATIO = 0.04;
const TRACK_PEAK_OPACITY = 0.95;

export function TearTrack({
  elapsed,
  doubling,
  size,
  color,
}: TearProps & { color: string }): React.JSX.Element {
  const trackStyle = useAnimatedStyle(() => {
    const { track } = glitchFrameAt(elapsed.value, doubling.value);
    return {
      opacity: track.opacity,
      transform: [{ translateY: track.top * size }],
    };
  }, [doubling, elapsed, size]);

  // One gradient id per instance, per `LightSweep`: two stages on a screen would
  // otherwise declare the same id and, on web, the first in the document wins for both.
  const gradientId = `mascot-track-${useId().replace(/:/g, '')}`;
  const width = size * (1 - 2 * TRACK_INSET_RATIO);

  return (
    <Animated.View
      style={[styles.track, { left: size * TRACK_INSET_RATIO, width }, trackStyle]}
      testID="mascot-track"
    >
      {/* A gradient, not a block: a hard-edged bar reads as an object crossing her,
          where the effect wanted is a line of light passing through. */}
      <Svg width={width} height={TRACK_HEIGHT}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            <Stop offset="0.5" stopColor={color} stopOpacity={TRACK_PEAK_OPACITY} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={TRACK_HEIGHT} fill={`url(#${gradientId})`} />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', height: '100%' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // `overflow: hidden` is load-bearing — it is what turns this view into the window
  // that cuts one horizontal band out of the figure.
  window: { position: 'absolute', left: 0, right: 0, top: 0, overflow: 'hidden' },
  track: { position: 'absolute', top: 0, height: TRACK_HEIGHT },
});
