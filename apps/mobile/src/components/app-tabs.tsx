import {
  TabList,
  TabSlot,
  TabTrigger,
  Tabs,
  type TabListProps,
  type TabTriggerSlotProps,
} from 'expo-router/ui';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassPill } from '@/design/glass';
import { usePulse } from '@/design/motion';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  paletteFor,
  type Palette,
} from '@/design/tokens';
import { useRole } from '@/hooks/use-role';

/**
 * The floating glass tab bar (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.3).
 *
 * The mock replaces the platform tab bar with a glass pill floating over the
 * content, so this uses `expo-router/ui`'s HEADLESS tabs rather than `NativeTabs`.
 * One implementation for both platforms now: `GlassSurface` carries its own
 * fallback, so the `.web` variant this file used to have is gone.
 *
 * STRUCTURE MATTERS. `TabList` discovers the navigator's screens from the
 * `TabTrigger` elements among its child ELEMENTS — before anything renders. So the
 * triggers must be DIRECT children of whatever `asChild` hands the list to; nesting
 * them inside another component's markup makes them invisible to that scan and the
 * navigator throws "Couldn't find any screens". Hence {@link GlassTabList}, which
 * takes the triggers as `children` and puts the chrome around them, exactly as the
 * previous web-only implementation did.
 *
 * Two tabs, as drawn: **Meetings** and **Live**. Account is NOT a tab — it is
 * reached from the Meetings header (Gustavo, 2026-07-28), keeping the bar at two
 * pills.
 *
 * Live stays role-gated. Not rendering its `TabTrigger` removes the tab AND its
 * navigation state, so a customer cannot reach the route at all — which is what we
 * want until Phase 9 gives the mic orb something to capture. `useRole` resolves to
 * 'customer' until proven otherwise, so the tab never flashes.
 */
export default function AppTabs(): React.JSX.Element {
  const scheme = useColorScheme();
  const palette = paletteFor(scheme);
  const role = useRole();
  const isInternal = role === 'developer' || role === 'admin';

  return (
    <Tabs>
      <TabSlot />
      <TabList asChild>
        <GlassTabList palette={palette}>
          <TabTrigger name="index" href="/" asChild>
            <TabButton palette={palette} label="Meetings" />
          </TabTrigger>
          {isInternal ? (
            <TabTrigger name="live" href="/live" asChild>
              <TabButton palette={palette} label="Live" showRecordDot />
            </TabTrigger>
          ) : null}
        </GlassTabList>
      </TabList>
    </Tabs>
  );
}

/**
 * The bar itself. Receives `TabList`'s props (including the trigger children) and
 * wraps them in the floating glass pill.
 */
function GlassTabList({
  palette,
  children,
  ...props
}: TabListProps & { palette: Palette }): React.JSX.Element {
  const insets = useSafeAreaInsets();

  return (
    <View
      {...props}
      style={[
        styles.barWrap,
        // The mock floats the bar 26px off the bottom; on a device with a home
        // indicator it has to clear that inset too, or the pill sits on it.
        { bottom: Math.max(Space.xxl, insets.bottom + Space.md) },
      ]}
    >
      <GlassPill palette={palette} tone="raised" elevated style={styles.bar}>
        {children}
      </GlassPill>
    </View>
  );
}

type TabButtonProps = TabTriggerSlotProps & {
  palette: Palette;
  label: string;
  /** The mock puts a pulsing record dot on the Live tab. */
  showRecordDot?: boolean;
};

function TabButton({
  palette,
  label,
  showRecordDot = false,
  isFocused,
  ...props
}: TabButtonProps): React.JSX.Element {
  const pulse = usePulse(true);

  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ selected: isFocused }}
      style={[
        styles.tab,
        isFocused === true && { backgroundColor: palette.accent },
      ]}
    >
      {showRecordDot ? (
        <Animated.View
          style={[styles.recordDot, { backgroundColor: palette.hot }, pulse]}
        />
      ) : null}
      <Text
        style={[
          styles.tabLabel,
          { color: isFocused === true ? '#ffffff' : palette.ink2 },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  barWrap: {
    position: 'absolute',
    left: Space.lg,
    right: Space.lg,
  },
  bar: {
    flexDirection: 'row',
    gap: 6,
    padding: 6,
  },
  tab: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
    borderRadius: Radius.pill,
  },
  tabLabel: {
    fontFamily: FontFamily.sansSemibold,
    fontSize: FontSize.label,
  },
  recordDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});
