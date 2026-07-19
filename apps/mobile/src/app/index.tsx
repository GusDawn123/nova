import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useHealth } from '@/hooks/use-health';

function HealthStatus() {
  const health = useHealth();

  switch (health.status) {
    case 'loading':
      return (
        <ThemedText type="default" themeColor="textSecondary">
          checking server…
        </ThemedText>
      );
    case 'success':
      return (
        <ThemedText type="default">
          Server: {health.data.ok ? 'ok' : 'not ok'} · v{health.data.version}
        </ThemedText>
      );
    case 'error':
      return (
        <ThemedView type="backgroundElement" style={styles.statusCard}>
          <ThemedText type="default">server unreachable</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {health.message}
          </ThemedText>
        </ThemedView>
      );
  }
}

export default function HomeScreen() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="title" style={styles.title}>
          Nova
        </ThemedText>
        <HealthStatus />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    flexDirection: 'row',
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    maxWidth: MaxContentWidth,
  },
  title: {
    textAlign: 'center',
  },
  statusCard: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
  },
});
