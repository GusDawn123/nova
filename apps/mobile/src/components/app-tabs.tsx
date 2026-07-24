import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
import { useRole } from '@/hooks/use-role';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'unspecified' ? 'light' : scheme];
  // Role gating (adr-0008): Test Live is an internal playground — visible to
  // developer/admin only. useRole resolves 'customer' until proven otherwise,
  // so the tab never flashes for customers. Display gating only — the server
  // enforces real permissions.
  const role = useRole();
  const isInternal = role === 'developer' || role === 'admin';

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{ selected: { color: colors.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>Explore</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      {/* "Test Live" — the typed-question testing playground for the Phase 7
          copilot loop. The real mic-driven Live screen (Phase 8/9) will replace
          this playground at the same `live` route and reclaim the "Live" name;
          the route file deliberately keeps its name (label-only rename,
          2026-07-23). Icon reuses explore.png as a placeholder — a dedicated
          icon is a Phase 8 (mobile UI polish) item. `hidden` is the SDK 57
          sanctioned conditional-trigger mechanism (native-tabs docs). */}
      <NativeTabs.Trigger name="live" hidden={!isInternal}>
        <NativeTabs.Trigger.Label>Test Live</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
