import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated from 'react-native-reanimated';

import { useReducedMotion, useShimmer } from '@/design/motion';
import { Radius, Space, type Palette } from '@/design/tokens';

/**
 * The Meetings list while it loads
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * Card-shaped placeholders rather than a spinner or a line of copy: the list is
 * about to arrive in this exact shape, so the wait costs no layout jump and says how
 * much is coming without claiming how long it will take.
 *
 * Lives beside `meeting-card.tsx` because it stands in for it — the two have to keep
 * the same corner, inset and rhythm, and that is easier to hold true when they are
 * neighbours than when one of them lives in the screen file.
 */

/** The bars a skeleton card stands in for: a title, then its meta line. */
const SKELETON_BARS: { width: DimensionValue; height: number }[] = [
  { width: '64%', height: 13 },
  { width: '38%', height: 9 },
];

/** Three of them — enough to read as "a list is coming", few enough to stay quiet. */
const SKELETON_COUNT = 3;

/**
 * The sheen's travel UNIT, in points — not the distance it covers.
 *
 * `useShimmer` translates by `unit × (-1.6 → 2.6)`, so the sheen starts 144pt off the
 * bar's left edge and finishes 234pt past its left edge: 378pt end to end, which
 * carries it clear across any bar a phone can show.
 */
const SHIMMER_TRAVEL = 90;

export function LoadingList({
  palette,
}: {
  palette: Palette;
}): React.JSX.Element {
  return (
    <View style={styles.list}>
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <View
          key={index}
          testID={`skeleton-card-${String(index)}`}
          style={[styles.card, { borderColor: palette.inkHairline }]}
        >
          {SKELETON_BARS.map((bar) => (
            <SkeletonBar
              key={String(bar.width)}
              palette={palette}
              width={bar.width}
              height={bar.height}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * One shimmering bar. Its own component because each bar needs its own hook — a
 * Reanimated style belongs to a single view.
 *
 * Reduced motion REMOVES the sheen rather than parking it, exactly as `LightSweep`
 * drops its band: a highlight stopped halfway along a bar reads as a rendering
 * artefact, and the bars alone already say "a list is coming". The loop is gated on
 * the same flag that removes it, so nothing repeats behind a view nobody renders.
 */
function SkeletonBar({
  palette,
  width,
  height,
}: {
  palette: Palette;
  width: DimensionValue;
  height: number;
}): React.JSX.Element {
  const reduced = useReducedMotion();
  const shimmer = useShimmer(SHIMMER_TRAVEL, !reduced);

  return (
    <View
      style={[
        styles.skeletonBar,
        { width, height, backgroundColor: palette.inkFill },
      ]}
    >
      {/* Ink fill over ink fill: the sheen is the same wash again, so the highlight
          is the two stacking rather than a brighter colour from somewhere else. */}
      {reduced ? null : (
        <Animated.View
          testID="skeleton-sheen"
          style={[
            styles.skeletonSheen,
            { backgroundColor: palette.inkFill },
            shimmer,
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: Space.md },
  // The real card's surface, to the point: same radius, same hairline, same inset
  // and the same internal gap, so nothing shifts when the meetings land.
  card: {
    borderRadius: Radius.soft,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Space.lg,
    gap: Space.xs2,
  },
  skeletonBar: {
    borderRadius: Radius.chip,
    overflow: 'hidden',
  },
  skeletonSheen: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: SHIMMER_TRAVEL / 2,
  },
});
