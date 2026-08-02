import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChamferSurface } from '@/design/chamfer';
import {
  FontFamily,
  FontSize,
  Size,
  Space,
  type Palette,
} from '@/design/tokens';

/**
 * The meeting detail's three views
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * Chamfered, because they act (spec §3), and the open one is FILLED rather than
 * tinted — the duotone has one ink, so "selected" cannot be a lighter shade of
 * anything. Fill and its inverse text is the only contrast the palette can spend.
 *
 * Dumb: it holds no state. Which tab is open belongs to the screen.
 */

export type DetailTab = 'notes' | 'transcript' | 'follow-up';

/**
 * Copy and order in one place, in the shape `capture-pane.tsx` uses.
 *
 * A `Record` keyed by the union, so a fourth view fails to compile here rather than
 * existing in the type and not on screen — which a plain array of pairs cannot do:
 * an array of three is a valid array however many members the union has.
 */
const TAB_LABELS: Record<DetailTab, string> = {
  notes: 'NOTES',
  transcript: 'TRANSCRIPT',
  'follow-up': 'FOLLOW-UP',
};

const TAB_ORDER: readonly DetailTab[] = ['notes', 'transcript', 'follow-up'];

export interface DetailTabsProps {
  readonly tab: DetailTab;
  readonly onSelect: (tab: DetailTab) => void;
  readonly palette: Palette;
}

export function DetailTabs({
  tab,
  onSelect,
  palette,
}: DetailTabsProps): React.JSX.Element {
  return (
    // `tab` is only a valid role inside a tablist: without this container the
    // selected state has nothing to be announced against.
    <View accessibilityRole="tablist" style={styles.row}>
      {TAB_ORDER.map((value) => {
        const selected = value === tab;
        return (
          <Pressable
            key={value}
            testID={`detail-tab-${value}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            // `aria-selected` alongside accessibilityState: react-native-web
            // renders the aria-* props as real DOM attributes, and that is the
            // only channel a screen reader has on the web target.
            aria-selected={selected}
            onPress={() => {
              onSelect(value);
            }}
            style={({ pressed }) => [
              styles.pill,
              pressed ? styles.pressed : undefined,
            ]}
          >
            <ChamferSurface
              fill={selected ? palette.ink : 'transparent'}
              stroke={selected ? undefined : palette.inkHairline}
              style={styles.surface}
              contentStyle={styles.surfaceContent}
            >
              <Text
                style={[
                  styles.label,
                  { color: selected ? palette.onInk : palette.inkSoft },
                ]}
              >
                {TAB_LABELS[value]}
              </Text>
            </ChamferSurface>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Space.sm2,
  },
  // The full 44pt floor as a REAL box rather than `hitSlop`: react-native-web
  // ignores hitSlop, and Expo Web is this project's verification target, so a
  // slop-only target would pass by eye and be untestable. The surface then fills
  // the pill, so the drawn polygon is the same box as the touch box.
  pill: { flex: 1, minHeight: Size.tapTarget },
  surface: { flex: 1 },
  surfaceContent: {
    flex: 1,
    paddingVertical: Space.md,
    paddingHorizontal: Space.sm2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
  },
  pressed: { opacity: 0.7 },
});
