import {
  TabList,
  TabSlot,
  TabTrigger,
  Tabs,
  type TabListProps,
  type TabTriggerSlotProps,
} from 'expo-router/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePulse } from '@/design/motion';
import { recordDotColor, tabBarFloatOffset } from '@/design/tab-bar-metrics';
import {
  FontFamily,
  FontSize,
  Radius,
  Size,
  Space,
  type Palette,
} from '@/design/tokens';
import { usePalette } from '@/hooks/use-appearance';
import { useRole } from '@/hooks/use-role';

/**
 * The floating tab bar
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5, and the bottom rail of
 * the gallery mockup).
 *
 * The design replaces the platform tab bar with a bar of its own floating over the
 * content, so this uses `expo-router/ui`'s HEADLESS tabs rather than `NativeTabs`.
 *
 * STRUCTURE MATTERS. `TabList` discovers the navigator's screens from the
 * `TabTrigger` elements among its child ELEMENTS — before anything renders. So the
 * triggers must be DIRECT children of whatever `asChild` hands the list to; nesting
 * them inside another component's markup makes them invisible to that scan and the
 * navigator throws "Couldn't find any screens". Hence {@link TabBar}, which takes
 * the triggers as `children` and puts the chrome around them.
 *
 * THREE tabs, as the mockup draws them. Account joined the bar in the last task of
 * the redesign, replacing the key that had been parked in the Meetings header as
 * its only route in.
 *
 * Live stays role-gated. Not rendering its `TabTrigger` removes the tab AND its
 * navigation state, so a customer cannot reach the route at all — which is what we
 * want until Phase 9 gives the mic orb something to capture. `useRole` resolves to
 * 'customer' until proven otherwise, so the tab never flashes.
 */

interface TabSpec {
  /** The route file's name inside `(tabs)`. */
  readonly name: string;
  readonly href: '/' | '/live' | '/account';
  /** Decoration, in the label but never in the accessible name. */
  readonly glyph: string;
  /** The word, already uppercase — mono is set in caps here, not transformed. */
  readonly label: string;
  /** What a screen reader says. */
  readonly a11yLabel: string;
  /** Developers and admins only, until Phase 9. */
  readonly internalOnly?: boolean;
  /** The pulsing record light, which only the Live tab carries. */
  readonly recordDot?: boolean;
}

/**
 * Order and copy in one place, so the bar cannot drift from the mockup a glyph at a
 * time. A tab added here without a matching route file fails at the navigator, not
 * silently.
 */
const TABS: readonly TabSpec[] = [
  { name: 'index', href: '/', glyph: '▤', label: 'MEETINGS', a11yLabel: 'Meetings' },
  {
    name: 'live',
    href: '/live',
    glyph: '◉',
    label: 'LIVE',
    a11yLabel: 'Live',
    internalOnly: true,
    recordDot: true,
  },
  {
    name: 'account',
    href: '/account',
    glyph: '◌',
    label: 'ACCOUNT',
    a11yLabel: 'Account',
  },
];

export default function AppTabs(): React.JSX.Element {
  const palette = usePalette();
  const role = useRole();
  const isInternal = role === 'developer' || role === 'admin';
  const visible = TABS.filter((tab) => isInternal || tab.internalOnly !== true);

  return (
    <Tabs>
      <TabSlot />
      <TabList asChild>
        <TabBar palette={palette}>
          {visible.map((tab) => (
            <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
              <TabButton palette={palette} tab={tab} />
            </TabTrigger>
          ))}
        </TabBar>
      </TabList>
    </Tabs>
  );
}

/**
 * The bar itself. Receives `TabList`'s props (including the trigger children) and
 * wraps them in the floating surface.
 *
 * CANVAS, opaque, with a hairline edge. The bar is absolutely positioned over a
 * scrolling list, so a translucent fill would let rows smear through it as they pass
 * underneath — the old glass surface's one real cost. Painting the canvas colour
 * makes it a clean slab that the list disappears behind, and the hairline is what
 * separates the slab from the identical canvas around it. Soft, not chamfered: the
 * bar is a container, and the chamfer is reserved for things that act (spec §3) —
 * which here is the tabs inside it.
 */
function TabBar({
  palette,
  children,
  ...props
}: TabListProps & { palette: Palette }): React.JSX.Element {
  const insets = useSafeAreaInsets();

  return (
    <View
      {...props}
      // The triggers below carry `accessibilityRole="tab"`, which is only a valid
      // role inside a tablist — without this the selected state announces against
      // nothing.
      accessibilityRole="tablist"
      style={[
        styles.barWrap,
        // The float comes from `tab-bar-metrics.ts`, which every screen also reads
        // through `tabBarClearance` to leave room for the bar. One value, not two
        // literals that happen to match.
        { bottom: tabBarFloatOffset(insets.bottom) },
      ]}
    >
      <View
        testID="tab-bar"
        style={[
          styles.bar,
          { backgroundColor: palette.canvas, borderColor: palette.inkHairline },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

type TabButtonProps = TabTriggerSlotProps & {
  palette: Palette;
  tab: TabSpec;
};

function TabButton({
  palette,
  tab,
  isFocused,
  ...props
}: TabButtonProps): React.JSX.Element {
  const focused = isFocused === true;
  // Only the tab that actually draws the dot animates. The hook is still called
  // unconditionally (Reanimated's rule); the flag gates the repeating timeline.
  const pulse = usePulse(tab.recordDot === true);

  return (
    <Pressable
      {...props}
      testID={`tab-${tab.name}`}
      accessibilityRole="tab"
      // The glyph is decoration: `◌ ACCOUNT` read literally is noise, and most
      // screen readers say nothing at all for a dotted circle.
      accessibilityLabel={tab.a11yLabel}
      // `aria-selected` rather than accessibilityState alone: react-native-web
      // renders the aria-* props as real DOM attributes, and accessibilityState
      // .selected reaches neither the DOM nor VoiceOver here — so which tab is
      // current would be silent to assistive tech. Both are set: the aria prop
      // for the web target, accessibilityState for native.
      accessibilityState={{ selected: focused }}
      aria-selected={focused}
      style={[styles.tab, focused && { backgroundColor: palette.ink }]}
    >
      {tab.recordDot === true ? (
        <Animated.View
          testID="record-dot"
          style={[
            styles.recordDot,
            { backgroundColor: recordDotColor(palette, focused) },
            pulse,
          ]}
        />
      ) : null}
      <Text
        testID={`tab-label-${tab.name}`}
        // One glyph, one word, one text run: they must never wrap apart.
        numberOfLines={1}
        style={[
          styles.tabLabel,
          // `inkSoft` at rest rather than `inkFaint` — an unselected tab is still a
          // destination the user has to be able to read (spec §11's ≥65% floor).
          { color: focused ? palette.onInk : palette.inkSoft },
        ]}
      >
        {`${tab.glyph} ${tab.label}`}
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
    gap: Space.xs2,
    padding: Space.xs2,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 1.5,
    overflow: 'hidden',
  },
  tab: {
    flex: 1,
    minHeight: Size.tapTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs2,
    borderRadius: Radius.pill,
  },
  tabLabel: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
  },
  recordDot: {
    width: Size.dot,
    height: Size.dot,
    borderRadius: Radius.pill,
  },
});
