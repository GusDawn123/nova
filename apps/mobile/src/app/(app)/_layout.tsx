import { Redirect } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import AppTabs from '@/components/app-tabs';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';

/**
 * Guard for the authenticated app: while the session is still resolving show a
 * neutral loading state; anything other than signed-in (signed-out OR the
 * unavailable misconfig) is sent to the auth flow, where the reason is shown.
 * Only a real session renders the tab navigator.
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

  return <AppTabs />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
  },
});
