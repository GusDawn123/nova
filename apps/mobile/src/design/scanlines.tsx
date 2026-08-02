import { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

import { decorative } from './decorative';

/**
 * Scanlines — the hologram texture
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7): 1px lines every 4px,
 * ~5% ink, riding the mascot constantly and available as an overlay wherever a
 * surface should read as projected rather than printed.
 *
 * STATIC BY DESIGN. It imports nothing from `motion.ts` and has no reduced-motion
 * branch, because there is no motion to reduce — the spec's doubling of the lines
 * belongs to the glitch timeline that drives it, not here. A texture that drifted
 * would turn a background into a thing to look at.
 *
 * Cost scales with height: one SVG rect per 4 points, so a 100pt panel is 25 nodes
 * and a full screen is roughly 200. That is fine over panels, cards and the mascot,
 * which is what it is for; it is not a wallpaper for a scrolling list.
 */

/** Line weight — a hairline, at the pixel the spec names. */
const SCANLINE_THICKNESS = 1;
/** Distance between the top of one line and the top of the next. */
const SCANLINE_SPACING = 4;
/** Spec §7: ~5%. Faint enough to feel like a screen, not a pattern. */
const SCANLINE_OPACITY = 0.05;

export interface ScanlinesProps {
  /** Line colour. Caller-supplied; this module knows no palette. */
  color: string;
  /** Overall overlay opacity. */
  opacity?: number;
}

export function Scanlines({
  color,
  opacity = SCANLINE_OPACITY,
}: ScanlinesProps): React.JSX.Element {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    // Same size in, same object out: layout fires on every re-layout, and a fresh
    // object each time would re-render every line for nothing.
    setBox((previous) =>
      previous !== null && previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);

  // Nothing to rule until the overlay has been measured; a zero box would emit an
  // empty svg on top of whatever it covers.
  const drawn = box !== null && box.width > 0 && box.height > 0 ? box : null;
  const tops =
    drawn === null
      ? []
      : Array.from(
          { length: Math.floor(drawn.height / SCANLINE_SPACING) },
          (_, index) => index * SCANLINE_SPACING,
        );

  return (
    <View
      {...decorative}
      style={[StyleSheet.absoluteFill, styles.overlay, { opacity }]}
      onLayout={handleLayout}
    >
      {drawn !== null ? (
        <Svg width={drawn.width} height={drawn.height}>
          {tops.map((top) => (
            <Rect
              key={top}
              x={0}
              y={top}
              width={drawn.width}
              height={SCANLINE_THICKNESS}
              fill={color}
            />
          ))}
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // It lies over content by definition, so it must never take a tap meant for what
  // it covers — nor an assistive-tech stop, which is the `decorative` spread above.
  overlay: { pointerEvents: 'none' },
});
