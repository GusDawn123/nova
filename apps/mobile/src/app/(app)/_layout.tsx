import { Redirect, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RingOrbit } from '@/design/ring-orbit';
import { FontFamily, FontSize, Space } from '@/design/tokens';
import { usePalette } from '@/hooks/use-appearance';
import { useAuth } from '@/hooks/use-auth';

/** The cross-fade between screens (spec §11: transitions are quiet, ~200ms). */
const TRANSITION_MS = 200;

/**
 * Guard for the authenticated app: while the session is still resolving show a
 * neutral loading state; anything other than signed-in (signed-out OR the
 * unavailable misconfig) is sent to the auth flow, where the reason is shown.
 * Only a real session renders the app.
 *
 * A STACK, not the tab navigator directly. The tabs are one screen in it and the
 * meeting detail is pushed on top — Account used to be pushed here too, and moved
 * into the tab group when it became a tab of its own.
 */
export default function AppLayout() {
  const auth = useAuth();
  const palette = usePalette();

  if (auth.status === 'loading') {
    // In brand from the first frame — this is the app's opening moment. The double
    // ring is the app's one waiting shape (spec §6), so the first thing the user
    // ever sees is the mark itself, doing the waiting.
    return (
      <View
        testID="app-waiting"
        style={[styles.center, { backgroundColor: palette.canvas }]}
      >
        <SafeAreaView style={styles.center}>
          <RingOrbit size={36} color={palette.ink} />
          <Text style={[styles.waiting, { color: palette.inkFaint }]}>
            ◌ ONE MOMENT
          </Text>
        </SafeAreaView>
      </View>
    );
  }

  if (auth.status !== 'signed-in') {
    return <Redirect href="/sign-in" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // A CROSS-FADE, not a slide. Every screen in this app is the same canvas
        // with different words on it, so a horizontal push reads as the whole field
        // sliding away rather than as content changing — and the fade is the gentler
        // answer for reduced motion besides, which is why it is not itself gated.
        animation: 'fade',
        animationDuration: TRANSITION_MS,
        // Each screen paints its own canvas edge-to-edge; an opaque default
        // underneath would flash the platform's own background through the fade.
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
    gap: Space.lg,
  },
  waiting: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    letterSpacing: 2,
  },
});
