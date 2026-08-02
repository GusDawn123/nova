import { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { useReducedMotion } from './motion';

/**
 * The ring orbit — the thinking indicator for every NON-live wait
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6): notes processing,
 * account operations. Live waits get the teleprompter's own language instead.
 *
 * It is the brand's double ring put to work: the outer ring holds steady, an inner
 * arc orbits inside it. That is why the spinner is this shape and not a generic
 * activity indicator — the mark itself is doing the waiting.
 *
 * Under reduced motion the double ring still draws and the ROTOR is not rendered at
 * all. Not rendering it is stronger than leaving it still: there is no animation to
 * accidentally start, and the DOM/native tree says so.
 */

/** Default diameter. Sized for an inline row; callers scale it up for a hero. */
const RING_SIZE = 24;
/** Both rings share one weight, or the pair reads as two unrelated circles. */
const RING_STROKE = 1.5;
/** The steady ring sits back so the moving arc is what the eye follows. */
const OUTER_RING_OPACITY = 0.35;
/** Gap between the two rings, in points. */
const RING_INSET = 4;
/** How much of the inner circle is drawn — the arc, as a fraction of the whole. */
const ARC_SWEEP = 0.28;
/** One revolution (spec §6: 1.1s). */
const ORBIT_DURATION_MS = 1100;

/**
 * One revolution per `durationMs`, linear, forever — gated the way `motion.ts`
 * gates `useShimmer`: the hook always runs, the loop is what reduced motion stops.
 */
function useOrbit(durationMs: number): AnimatedStyle<ViewStyle> {
  const turn = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      turn.value = 0;
      return;
    }
    turn.value = withRepeat(
      withTiming(1, { duration: durationMs, easing: Easing.linear }),
      -1,
      false,
    );
  }, [durationMs, reduced, turn]);

  // Explicit deps rather than the Babel plugin's inference — see `light-sweep.tsx`.
  return useAnimatedStyle(
    () => ({ transform: [{ rotate: `${String(turn.value * 360)}deg` }] }),
    [turn],
  );
}

export interface RingOrbitProps {
  /** Diameter in points. */
  size?: number;
  /** Ring colour. Caller-supplied; this module knows no palette. */
  color: string;
}

export function RingOrbit({
  size = RING_SIZE,
  color,
}: RingOrbitProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const spin = useOrbit(ORBIT_DURATION_MS);

  const center = size / 2;
  // Half the stroke sits outside the path, so the radius has to pull in by that
  // much or the ring is clipped by its own box.
  const outerRadius = Math.max(RING_STROKE, (size - RING_STROKE) / 2);
  const innerRadius = Math.max(RING_STROKE, outerRadius - RING_INSET);
  const innerCircumference = 2 * Math.PI * innerRadius;

  // One arc, then a gap the length of the whole circle: a dash pattern is how you
  // draw a partial circle without computing an SVG path.
  const arc = (
    <Svg width={size} height={size}>
      <Circle
        cx={center}
        cy={center}
        r={innerRadius}
        stroke={color}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${String(innerCircumference * ARC_SWEEP)} ${String(
          innerCircumference,
        )}`}
        fill="transparent"
      />
    </Svg>
  );

  return (
    <View style={[styles.root, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        <Circle
          cx={center}
          cy={center}
          r={outerRadius}
          stroke={color}
          strokeOpacity={OUTER_RING_OPACITY}
          strokeWidth={RING_STROKE}
          fill="transparent"
        />
      </Svg>
      {reduced ? (
        <View style={StyleSheet.absoluteFill}>{arc}</View>
      ) : (
        <Animated.View
          style={[StyleSheet.absoluteFill, spin]}
          testID="ring-orbit-rotor"
        >
          {arc}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { pointerEvents: 'none' },
});
