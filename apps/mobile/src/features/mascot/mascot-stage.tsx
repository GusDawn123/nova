import { Image } from 'expo-image';
import { useEffect, useId } from 'react';
import { StyleSheet, Text, View, type DimensionValue } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { useReducedMotion } from '@/design/motion';
import { Scanlines } from '@/design/scanlines';

import eyePatchArt from '../../../assets/mascot/eye-patch.png';
import eyesOpenArt from '../../../assets/mascot/eyes-open.png';
import { createBlinkClock } from './blink-clock';
import { eventDurationMs, glitchFrameAt, patchOpacityAt } from './mascot-glitch';
import { TearGhosts, TearSlice, TearTrack } from './mascot-tear';

/**
 * MascotStage — she is a hologram
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7).
 *
 * At rest she is one image — `eyes-open.png` — floating on a slow breath with
 * scanlines whispering across her. Every few seconds she blinks, the blink tears the
 * projection for a fifth of a second, and then she is perfectly still again.
 *
 * ---------------------------------------------------------------------------
 * The patch, and why it is not a frame swap
 * ---------------------------------------------------------------------------
 * `eyes-closed.png` is NEVER rendered. The two drawings came out of separate
 * generations and are not pixel-identical, so cross-fading the full frames shifts her
 * whole face. `scripts/make_blink_patch.sh` cut `eye-patch.png` out of the closed
 * frame at a box whose four edges lie where the two images already AGREE — agreeing
 * pixels cross-fade into themselves, so the seam is invisible at every alpha, not just
 * at the ends.
 *
 * That crop is worthless without its origin, so the placement below is derived from
 * the script's own pinned box rather than written out as four percentages. Re-pinning
 * the crop changes {@link PATCH_BOX_PX} here and the SEAM numbers there in one move.
 *
 * ---------------------------------------------------------------------------
 * One clock
 * ---------------------------------------------------------------------------
 * There is a single animated value for the whole event — elapsed milliseconds — and
 * every channel is a pure read of it through `mascot-glitch.ts`. The tear layers take
 * that value as a prop rather than owning one, so the spec's "blink and glitch cannot
 * drift" is a property of the shape rather than a thing to stay careful about.
 *
 * The breath is deliberately NOT on that clock: it is a loop, not an event, and tying
 * a 6.5s bob to a 200ms tear would only mean restarting the bob on every blink.
 *
 * Reduced motion leaves a drawing someone would have made on purpose — her open eyes,
 * the projection texture, still sparkles — and starts nothing: no loop, no blink
 * timer, and no ghost, slice or tracking line rendered at all.
 */

/** Default stage box (the demo's figure). */
const DEFAULT_SIZE = 250;

/** The art is authored square at this resolution; the crop box is in its pixels. */
const SOURCE_FRAME_PX = 1254;

/**
 * THE PLACEMENT CONTRACT — the box `scripts/make_blink_patch.sh` pins, in source-art
 * pixels. It prints these same four numbers as percentages on every run.
 */
const PATCH_BOX_PX = { left: 420, top: 486, right: 812, bottom: 684 } as const;

/** Pixels of source art → a share of the rendered figure, at any size it is drawn. */
function frameShare(px: number): DimensionValue {
  return `${(px / SOURCE_FRAME_PX) * 100}%`;
}

const PATCH_LAYOUT = {
  position: 'absolute',
  left: frameShare(PATCH_BOX_PX.left),
  top: frameShare(PATCH_BOX_PX.top),
  width: frameShare(PATCH_BOX_PX.right - PATCH_BOX_PX.left),
  height: frameShare(PATCH_BOX_PX.bottom - PATCH_BOX_PX.top),
} as const;

/** Spec §7: "slow float (±5-6px, ~6.5s)". */
const FLOAT_MS = 6500;
const FLOAT_TOP = -5;
const FLOAT_BOTTOM = 6;

/** Spec §7: scanlines at ~5%, doubled while the projection tears. */
const SCANLINE_REST_OPACITY = 0.05;
const SCANLINE_GLITCH_OPACITY = 0.1;

/** The halo she is projected into: a soft radial falloff, ink on canvas. */
const GLOW_RADIUS_RATIO = 0.44;
const GLOW_OPACITY = 0.16;

/** One twinkle, and the rest/peak the `✦` glyphs breathe between (demo: 3.2s). */
const TWINKLE_MS = 3200;
const TWINKLE_REST = 0.15;
const TWINKLE_PEAK = 0.9;
const TWINKLE_SCALE_REST = 0.8;
const TWINKLE_SCALE_PEAK = 1.15;

/**
 * Where the sparkles sit, as shares of the stage box, with the demo's stagger. They
 * hug the edges: a `✦` over her face reads as a blemish rather than as atmosphere.
 */
const SPARKLES = [
  { top: 0.02, left: 0.04, glyph: 0.044, delayMs: 0 },
  { top: 0.16, left: 0.9, glyph: 0.028, delayMs: 1100 },
  { top: 0.44, left: 0.02, glyph: 0.024, delayMs: 2200 },
  { top: 0.72, left: 0.93, glyph: 0.036, delayMs: 600 },
  { top: 0.88, left: 0.1, glyph: 0.024, delayMs: 1700 },
] as const;

export interface MascotStageProps {
  /** Side of the square stage, in points. */
  size?: number;
  /**
   * The ink. Caller-supplied; this module knows no palette — the same contract
   * `Scanlines` and `LightSweep` keep.
   */
  color: string;
  /** Sparkles around her. On by default: they are part of the figure, not a variant. */
  sparkles?: boolean;
}

export function MascotStage({
  size = DEFAULT_SIZE,
  color,
  sparkles = true,
}: MascotStageProps): React.JSX.Element {
  const reduced = useReducedMotion();

  // THE clock: milliseconds since the current blink event began, parked at the end of
  // the timeline — where every channel reads zero — between events.
  const elapsed = useSharedValue(0);
  const doubling = useSharedValue(false);
  const breath = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      breath.value = 0.5;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, { duration: FLOAT_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [breath, reduced]);

  useEffect(() => {
    if (reduced) return;

    const clock = createBlinkClock();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = (): void => {
      const event = clock.next();
      timer = setTimeout(() => {
        const duration = eventDurationMs(event.double);
        doubling.value = event.double;
        // Reset first: a blink arriving while one is still running restarts the
        // timeline rather than layering a second animation over it.
        elapsed.value = 0;
        elapsed.value = withTiming(duration, { duration, easing: Easing.linear });
        arm();
      }, event.delayMs);
    };

    arm();
    // The chain re-arms itself, so the cleanup has to clear the LATEST timer, not the
    // first — hence the mutable binding rather than a value captured at arm time.
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [doubling, elapsed, reduced]);

  const floatStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateY: FLOAT_TOP + (FLOAT_BOTTOM - FLOAT_TOP) * breath.value }],
    }),
    [breath],
  );

  const jitterStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: glitchFrameAt(elapsed.value, doubling.value).jitter }],
    }),
    [doubling, elapsed],
  );

  const patchStyle = useAnimatedStyle(
    () => ({ opacity: patchOpacityAt(elapsed.value, doubling.value) }),
    [doubling, elapsed],
  );

  const scanlineStyle = useAnimatedStyle(() => {
    const { scanBoost } = glitchFrameAt(elapsed.value, doubling.value);
    return {
      opacity:
        SCANLINE_REST_OPACITY +
        (SCANLINE_GLITCH_OPACITY - SCANLINE_REST_OPACITY) * scanBoost,
    };
  }, [doubling, elapsed]);

  // Per `LightSweep`: two stages on one screen would otherwise declare the same
  // gradient id, and on web the first in the document wins for both.
  const glowId = `mascot-glow-${useId().replace(/:/g, '')}`;
  const tear = { elapsed, doubling, size };

  return (
    <View style={[styles.stage, { width: size, height: size }]} testID="mascot-stage">
      {sparkles
        ? SPARKLES.map((sparkle) => (
            <Sparkle
              key={`${sparkle.top}-${sparkle.left}`}
              color={color}
              delayMs={sparkle.delayMs}
              left={sparkle.left * size}
              top={sparkle.top * size}
              fontSize={sparkle.glyph * size}
            />
          ))
        : null}

      <Animated.View style={[StyleSheet.absoluteFill, floatStyle]}>
        <Animated.View style={[StyleSheet.absoluteFill, jitterStyle]}>
          <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
            <Defs>
              <RadialGradient id={glowId}>
                <Stop offset="0" stopColor={color} stopOpacity={GLOW_OPACITY} />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={size * GLOW_RADIUS_RATIO}
              fill={`url(#${glowId})`}
            />
          </Svg>

          {/* Echoes BEHIND her, so they peel off the figure rather than washing it out. */}
          {reduced ? null : <TearGhosts {...tear} color={color} />}

          <Image
            source={eyesOpenArt}
            style={styles.frame}
            contentFit="contain"
            testID="mascot-base"
          />

          {reduced ? null : <TearSlice {...tear} />}

          <Animated.View style={[PATCH_LAYOUT, patchStyle]} testID="mascot-patch">
            {/* `fill`, not `contain`: the crop is stretched back into the exact box it
                was taken from, so any letterboxing would be a misregistration. */}
            <Image
              source={eyePatchArt}
              style={styles.frame}
              contentFit="fill"
              testID="mascot-patch-art"
            />
          </Animated.View>

          <Animated.View
            style={[StyleSheet.absoluteFill, scanlineStyle]}
            testID="mascot-scanlines"
          >
            {/* Strength is driven from HERE, at full opacity inside: spec §7's
                "scanlines double" belongs to the glitch timeline, which is exactly
                what `Scanlines` says it is staying out of. */}
            <Scanlines color={color} opacity={1} />
          </Animated.View>

          {reduced ? null : <TearTrack {...tear} color={color} />}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

interface SparkleProps {
  color: string;
  delayMs: number;
  left: number;
  top: number;
  fontSize: number;
}

/**
 * One `✦`, breathing on its own staggered clock.
 *
 * Its own component because each glyph needs its own hooks, and reduced motion parks
 * it at full presence rather than removing it — a sparkle is a mark in the drawing,
 * not a piece of motion, so what remains is still the picture as designed.
 */
function Sparkle({
  color,
  delayMs,
  left,
  top,
  fontSize,
}: SparkleProps): React.JSX.Element {
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withTiming(1, { duration: TWINKLE_MS / 2, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      ),
    );
  }, [delayMs, progress, reduced]);

  const twinkleStyle = useAnimatedStyle(
    () => ({
      opacity: TWINKLE_REST + (TWINKLE_PEAK - TWINKLE_REST) * progress.value,
      transform: [
        {
          scale:
            TWINKLE_SCALE_REST +
            (TWINKLE_SCALE_PEAK - TWINKLE_SCALE_REST) * progress.value,
        },
      ],
    }),
    [progress],
  );

  return (
    <Animated.View style={[styles.sparkle, { left, top }, twinkleStyle]}>
      <Text style={{ color, fontSize }}>✦</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // She is a picture, never a control: nothing here may take a tap meant for the
  // button she is sitting above.
  stage: { position: 'relative', pointerEvents: 'none' },
  frame: { width: '100%', height: '100%' },
  sparkle: { position: 'absolute' },
});
