import { useCallback, useEffect, useId, useState } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { decorative } from './decorative';
import { useReducedMotion } from './motion';

/**
 * The light sweep — "she is working on it"
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6).
 *
 * A hairline rail with a bright band travelling along it: processing rows in the
 * meetings list, section reveals in notes. It says WORKING without saying how far
 * along — which is the honest signal, because none of the waits it covers report
 * progress. Never on the teleprompter stream (spec §6): the caret owns that.
 *
 * Reduced motion leaves the rail and removes the band entirely rather than freezing
 * it mid-track. A stopped highlight parked at 40% reads as a stalled progress bar,
 * which is a claim the component cannot back up.
 *
 * The band is drawn as an SVG gradient rather than a coloured `View` so the light
 * falls off at both ends. A hard-edged block sliding past reads as an object moving;
 * a gradient reads as light passing over, which is the whole effect.
 *
 * No palette is imported here. `color` arrives from the caller, which already knows
 * its theme — the same contract `ChamferSurface` keeps.
 */

/** The rail is a hairline: it frames the sweep, it is not itself the signal. */
const TRACK_HEIGHT = 2;
/** One full traverse. Slow enough to read as travel, quick enough to feel alive. */
const SWEEP_DURATION_MS = 1400;
/** Band width as a fraction of the track, so the effect scales with the row. */
const BAND_WIDTH_RATIO = 0.38;
/** Floor for the band on very narrow tracks, where the fraction collapses. */
const BAND_MIN_WIDTH = 24;
/** The rail sits well under the band — present, but not a line you read. */
const RAIL_OPACITY = 0.18;
/** Peak of the gradient at the band's centre; both ends fade to nothing. */
const BAND_PEAK_OPACITY = 0.9;

/**
 * The traverse: 0 → 1 across `distance`, linear, forever.
 *
 * Gated exactly like `useShimmer` in `motion.ts` — the hook is called
 * unconditionally (Reanimated requires that) and the infinite `withRepeat` is what
 * the flags switch off. Under reduced motion, or before the track has been measured,
 * NOTHING starts.
 */
function useSweepTravel(
  distance: number,
  durationMs: number,
  running: boolean,
): AnimatedStyle<ViewStyle> {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced || !running) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, { duration: durationMs, easing: Easing.linear }),
      -1,
      false,
    );
  }, [durationMs, progress, reduced, running]);

  // Explicit deps rather than the Babel plugin's inference: Reanimated requires one
  // or the other, and only this form also renders where the plugin does not run.
  return useAnimatedStyle(
    () => ({ transform: [{ translateX: distance * progress.value }] }),
    [distance, progress],
  );
}

export interface LightSweepProps {
  /** The light's colour. Caller-supplied; this module knows no palette. */
  color: string;
  /** Track height in points. Defaults to the hairline rail. */
  height?: number;
  /** One traverse, in ms. */
  durationMs?: number;
  /** Layout style — width, margin, where the track sits. */
  style?: StyleProp<ViewStyle>;
}

export function LightSweep({
  color,
  height = TRACK_HEIGHT,
  durationMs = SWEEP_DURATION_MS,
  style,
}: LightSweepProps): React.JSX.Element {
  const [width, setWidth] = useState(0);
  const reduced = useReducedMotion();

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    setWidth((previous) => (previous === measured ? previous : measured));
  }, []);

  const bandWidth = Math.max(BAND_MIN_WIDTH, width * BAND_WIDTH_RATIO);
  // The band starts fully off the left edge and finishes fully off the right, so the
  // light enters and leaves rather than popping in at the boundary.
  const travel = useSweepTravel(width + bandWidth, durationMs, width > 0);

  // One gradient per instance. Two sweeps on a screen would otherwise declare the
  // same `id`, and on web the first one in the document wins for both. React's ids
  // contain colons, which are legal in an id but noisy in a `url(#…)` reference.
  const gradientId = `light-sweep-${useId().replace(/:/g, '')}`;

  return (
    // Hidden from assistive tech (`decorative`): the whole track is the wordless half
    // of a message whose words are always next to it, and it reports no progress a
    // reader could usefully announce.
    <View
      {...decorative}
      style={[styles.track, { height }, style]}
      onLayout={handleLayout}
    >
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: color, opacity: RAIL_OPACITY },
        ]}
      />
      {!reduced && width > 0 ? (
        <Animated.View
          style={[styles.band, { width: bandWidth, left: -bandWidth }, travel]}
          testID="light-sweep-band"
        >
          <Svg width={bandWidth} height={height}>
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={color} stopOpacity={0} />
                <Stop
                  offset="0.5"
                  stopColor={color}
                  stopOpacity={BAND_PEAK_OPACITY}
                />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect
              x={0}
              y={0}
              width={bandWidth}
              height={height}
              fill={`url(#${gradientId})`}
            />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // `overflow: hidden` is load-bearing: it is what clips the band at both ends of
  // the rail instead of letting it slide across whatever sits beside the track.
  track: { overflow: 'hidden', pointerEvents: 'none' },
  band: { position: 'absolute', top: 0, bottom: 0 },
});
