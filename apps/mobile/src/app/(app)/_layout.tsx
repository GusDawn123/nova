import { Redirect, Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';

/**
 * Guard for the authenticated app: while the session is still resolving show a
 * neutral loading state; anything other than signed-in (signed-out OR the
 * unavailable misconfig) is sent to the auth flow, where the reason is shown.
 * Only a real session renders the app.
 *
 * A STACK, not the tab navigator directly (Phase 8.5, `docs/DESIGN/notes-ui.md`
 * §7.3). The tabs are one screen in it; Account and the meeting detail are pushed
 * on top. That structure is forced by the design: `expo-router/ui` removes a route
 * from navigation entirely when no `TabTrigger` renders for it, so a screen that
 * must be reachable WITHOUT being a tab — Account, per Gustavo's two-pill bar —
 * cannot live inside the tab navigator at all.
 */
export default function AppLayout() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <ThemedView style={styles.center}>
        <SafeAreaView style={styles.center}>
          <ThemedText type="default" themeColor="textSecondary">
            loading…
          </ThemedText>
        </SafeAreaView>
      </ThemedView>
    );
  }

  if (auth.status !== 'signed-in') {
    return <Redirect href="/sign-in" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // The glass screens paint their own gradient edge-to-edge; a card
        // presentation over an opaque default background would flash white on push.
        contentStyle: { backgroundColor: 'transparent' },
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
  },
});
