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
 * Order and copy in one place. A `Record`-backed tuple, so a fourth view fails to
 * compile here rather than existing in the type and not on screen.
 */
const TABS: readonly { readonly tab: DetailTab; readonly label: string }[] = [
  { tab: 'notes', label: 'NOTES' },
  { tab: 'transcript', label: 'TRANSCRIPT' },
  { tab: 'follow-up', label: 'FOLLOW-UP' },
];

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
      {TABS.map((entry) => {
        const selected = entry.tab === tab;
        return (
          <Pressable
            key={entry.tab}
            testID={`detail-tab-${entry.tab}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            // `aria-selected` alongside accessibilityState: react-native-web
            // renders the aria-* props as real DOM attributes, and that is the
            // only channel a screen reader has on the web target.
            aria-selected={selected}
            onPress={() => {
              onSelect(entry.tab);
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
                {entry.label}
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
  pill: { flex: 1 },
  surface: { minHeight: Size.tapTarget - Space.md },
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
