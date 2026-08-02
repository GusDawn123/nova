import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, type Palette } from './tokens';

/**
 * Glass surfaces (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.1).
 *
 * The mock's glass is `backdrop-filter: blur() saturate()` over a translucent fill.
 * iOS 26 has the real thing — `expo-glass-effect`'s `GlassView`, backed by
 * `UIVisualEffectView` — so that is used where available.
 *
 * TWO constraints from the SDK 57 docs shape this file:
 *
 *  1. **`GlassView` requires iOS 26+** and silently degrades to a plain `View`
 *     elsewhere (older iOS, Android, web). "Silently" is the problem: a bare `View`
 *     has no fill, no border and no shadow, so the card would vanish into the
 *     background rather than look slightly flatter. {@link GlassSurface} therefore
 *     ALWAYS paints the translucent fill, border and shadow itself, and treats the
 *     native blur as an enhancement on top. The fallback is a real design, not an
 *     accident.
 *
 *  2. **`opacity: 0` on a `GlassView` — or on ANY ancestor — stops the glass
 *     rendering at all.** The mock's `cardIn`/`riseIn` keyframes both animate opacity
 *     from 0, so applying them naively to these surfaces would produce cards that
 *     never show their glass and no error to explain why. `design/motion.ts` provides
 *     transform-only entrances for exactly this reason; see the note there.
 */

/** Whether the platform can render real liquid glass (iOS 26+). */
export const hasLiquidGlass = isLiquidGlassAvailable();

export interface GlassSurfaceProps {
  palette: Palette;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** `regular` is the standard fill; `raised` is the mock's `--glassHi`. */
  tone?: 'regular' | 'raised';
  /** Corner radius; defaults to the large card radius. */
  radius?: number;
  /** Drop shadow. Off for inline chips, on for cards that float. */
  elevated?: boolean;
  testID?: string;
}

/**
 * The base glass surface every card, pill and button is built from.
 *
 * TWO nodes, and the split is load-bearing: on iOS `overflow: 'hidden'` clips the
 * layer that draws the shadow, so a surface that both clipped its blur AND cast a
 * shadow from one node lost the shadow entirely — silently, and only on iOS, since
 * Android's `elevation` is drawn by the platform and kept showing. So the OUTER node
 * casts the shadow and the INNER node does the clipping. The radius is on both: the
 * outer's is what gives the shadow the card's silhouette instead of a rectangle's.
 *
 * Everything else — border, fill, the blur, the sheen, the consumer's `style` and
 * the children — lives on the inner node, because that is the box the design draws.
 * The outer contributes no layout of its own, so a consumer's padding, gap, size or
 * `alignSelf` lands where it always did.
 *
 * Layering inside, back to front: the native `GlassView` (when available) for the
 * blur, then the translucent fill, then the sheen, then children — matching how the
 * CSS composites.
 */
export function GlassSurface({
  palette,
  children,
  style,
  tone = 'regular',
  radius = Radius.card,
  elevated = false,
  testID,
}: GlassSurfaceProps): React.JSX.Element {
  const fill = tone === 'raised' ? palette.glassHi : palette.glass;

  return (
    <View
      style={
        elevated
          ? {
              borderRadius: radius,
              shadowColor: palette.shadowColor,
              shadowOpacity: palette.shadowOpacity,
              shadowRadius: palette.shadowRadius,
              shadowOffset: { width: 0, height: palette.shadowOffsetY },
              elevation: palette.elevation,
            }
          : undefined
      }
    >
      <View
        // On the inner node: this is where the fill, border and radius that a
        // consumer or a test reads about the surface actually are.
        testID={testID}
        style={[
          {
            borderRadius: radius,
            borderWidth: StyleSheet.hairlineWidth * 1.5,
            borderColor: palette.stroke,
            // `overflow: hidden` clips the blur to the radius. It also clips
            // children, which every consumer here wants.
            overflow: 'hidden',
            backgroundColor: fill,
          },
          style,
        ]}
      >
        {hasLiquidGlass ? (
          <GlassView
            glassEffectStyle="regular"
            // `auto` follows the system appearance, which is what the palette is
            // already keyed to — passing it explicitly would double-resolve.
            colorScheme="auto"
            // `pointerEvents` goes in the style, not as a prop — the prop form is
            // deprecated in RN 0.86.
            style={[StyleSheet.absoluteFill, styles.passthrough]}
          />
        ) : null}
        {/* The sheen: the mock's `inset 0 1px 0 var(--sheen)`. RN has no inset
            shadow, so it is a one-pixel highlight line along the top edge. */}
        <View
          style={[
            styles.sheen,
            styles.passthrough,
            { backgroundColor: palette.sheen },
          ]}
        />
        {children}
      </View>
    </View>
  );
}

/** A pill-shaped glass surface — chips, the tab bar, the record badge. */
export function GlassPill({
  palette,
  children,
  style,
  tone = 'regular',
  elevated = false,
  testID,
}: Omit<GlassSurfaceProps, 'radius'>): React.JSX.Element {
  return (
    <GlassSurface
      palette={palette}
      tone={tone}
      radius={Radius.pill}
      elevated={elevated}
      style={style}
      testID={testID}
    >
      {children}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  /** Decoration must never eat a tap meant for the card underneath. */
  passthrough: { pointerEvents: 'none' },
  sheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
});
