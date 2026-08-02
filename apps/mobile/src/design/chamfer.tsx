import { useCallback, useState, type ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Polygon, Polyline } from 'react-native-svg';

import { decorative } from './decorative';
import { Chamfer } from './tokens';

/**
 * The chamfered surface — Nova's control language
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §3).
 *
 * ONE rule, encoded once: a 45° cut on the top-left and bottom-right corners means
 * the thing is actionable; square corners mean it is static. Every button, field,
 * chip and key in the app is this component, so the shape cannot drift between them.
 *
 * Neither React Native nor CSS can express that outline on a `View` — `borderRadius`
 * rounds, and RN has no `clip-path` — so the silhouette is drawn as an SVG polygon on
 * a layer behind the children. That polygon needs the box's pixel size (a 45° cut is
 * an absolute 8pt, not a percentage, so a scaled `viewBox` would skew it), which is
 * only known after layout. Hence `onLayout`: the first frame draws nothing and the
 * second draws the shape. Anything that must never flash unpainted should carry its
 * own background on the `style` it passes in.
 *
 * This module imports no palette. Fill and stroke arrive as props so the caller —
 * which already knows its theme — decides, and so one surface can be white-on-blue
 * and its neighbour blue-on-white without this file knowing either theme exists.
 */

/** Arm length of a focus bracket, along each edge it runs down. */
const BRACKET_ARM = 7;
/** Focus brackets are heavier than the resting outline, so they read as a state. */
const BRACKET_STROKE_WIDTH = 2;

/**
 * Clamp the cut so the outline stays convex.
 *
 * Past half the shorter side the two cuts cross and the polygon folds through
 * itself — a bow-tie rather than a chamfered box. Small surfaces (a 10pt-tall
 * indicator asking for the 8pt control cut) hit this routinely, so the clamp is
 * the normal path, not a guard against misuse.
 */
function clampCut(w: number, h: number, cut: number): number {
  return Math.max(0, Math.min(cut, Math.min(w, h) / 2));
}

/**
 * The outline: top-left and bottom-right cut, the other two square.
 *
 * Returned as an SVG `points` string — six vertices, clockwise from the top of the
 * top-left cut. Pure, so the geometry is testable without a renderer.
 */
export function chamferPoints(w: number, h: number, cut: number): string {
  const c = clampCut(w, h, cut);

  return [
    `${String(c)},0`,
    `${String(w)},0`,
    `${String(w)},${String(h - c)}`,
    `${String(w - c)},${String(h)}`,
    `0,${String(h)}`,
    `0,${String(c)}`,
  ].join(' ');
}

/**
 * One focus bracket: a short arm along an edge, the cut itself, then a short arm
 * along the other edge. The arm is clamped the same way the cut is, so on a tiny
 * surface the two brackets shorten instead of overrunning each other.
 */
function bracketPoints(
  w: number,
  h: number,
  cut: number,
  corner: 'topLeft' | 'bottomRight',
): string {
  const c = clampCut(w, h, cut);
  const arm = Math.max(0, Math.min(BRACKET_ARM, Math.min(w, h) - c));

  return corner === 'topLeft'
    ? `${String(c + arm)},0 ${String(c)},0 0,${String(c)} 0,${String(c + arm)}`
    : `${String(w - c - arm)},${String(h)} ${String(w - c)},${String(h)} ` +
        `${String(w)},${String(h - c)} ${String(w)},${String(h - c - arm)}`;
}

export interface ChamferSurfaceProps {
  /** Cut size in points. Defaults to the control cut; keys use `Chamfer.key`. */
  cut?: number;
  /** Interior fill. Transparent by default — an outline is the resting state. */
  fill?: string;
  /** Outline colour. Omitted draws no outline; the caller passes a palette value. */
  stroke?: string;
  strokeWidth?: number;
  /**
   * Focus brackets at the two cut corners. They take the same `stroke` colour, so a
   * focused control raises `stroke` to `palette.ink` and turns these on together.
   */
  brackets?: boolean;
  /** Layout style — size, margin, and how the content block is positioned. */
  style?: StyleProp<ViewStyle>;
  /** Overrides the content inset for surfaces that need it tighter than the cut. */
  contentStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
  testID?: string;
}

export function ChamferSurface({
  cut = Chamfer.control,
  fill = 'transparent',
  stroke,
  strokeWidth = 1,
  brackets = false,
  style,
  contentStyle,
  children,
  testID,
}: ChamferSurfaceProps): React.JSX.Element {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    // Same size in, same object out: layout fires on every re-layout, and a fresh
    // object each time would re-render the whole subtree for nothing.
    setBox((previous) =>
      previous !== null && previous.width === width && previous.height === height
        ? previous
        : { width, height },
    );
  }, []);

  // A zero-size box collapses all six vertices onto the origin, which paints a stray
  // dot rather than nothing. Draw only once there is a box to draw on.
  const drawn = box !== null && box.width > 0 && box.height > 0 ? box : null;

  return (
    <View style={style} onLayout={handleLayout} testID={testID}>
      {drawn !== null ? (
        // The layer is FIRST in the tree, which puts it behind the children on both
        // targets: native paints siblings in order, and every react-native-web view
        // is `position: relative; z-index: 0`, so document order is paint order there
        // too. It is decoration, so it must never intercept a tap for the control —
        // nor be walked into by a screen reader on the way to the control's label.
        // Only this LAYER is hidden; `children` are the content and stay reachable.
        <View {...decorative} style={[StyleSheet.absoluteFill, styles.layer]}>
          <Svg width={drawn.width} height={drawn.height}>
            <Polygon
              points={chamferPoints(drawn.width, drawn.height, cut)}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
            {brackets ? (
              <>
                <Polyline
                  points={bracketPoints(drawn.width, drawn.height, cut, 'topLeft')}
                  fill="transparent"
                  stroke={stroke}
                  strokeWidth={BRACKET_STROKE_WIDTH}
                />
                <Polyline
                  points={bracketPoints(
                    drawn.width,
                    drawn.height,
                    cut,
                    'bottomRight',
                  )}
                  fill="transparent"
                  stroke={stroke}
                  strokeWidth={BRACKET_STROKE_WIDTH}
                />
              </>
            ) : null}
          </Svg>
        </View>
      ) : null}
      {/* Inset by the cut, which is exactly where the diagonal stops eating into the
          box — content any closer to a cut corner gets clipped by the outline. The
          CLAMPED cut, not the raw prop: on a surface too small to take the full cut
          the polygon draws a shorter diagonal, and padding to the asked-for size
          would inset the content past the shape actually painted. Before the first
          measurement there is no box to clamp against, and nothing is drawn yet
          either, so the raw cut stands. */}
      <View
        style={[
          {
            padding:
              drawn === null
                ? Math.max(0, cut)
                : clampCut(drawn.width, drawn.height, cut),
          },
          contentStyle,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { pointerEvents: 'none' },
});
