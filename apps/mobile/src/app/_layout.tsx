import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/hooks/use-auth';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout. `AuthProvider` wraps the whole tree so every route can read the
 * session; the root `Stack` hosts the two route groups — `(auth)` (sign-in /
 * sign-up) and `(app)` (the tab navigator) — each of which guards itself.
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <Stack screenOptions={{ headerShown: false }} />
      </ThemeProvider>
    </AuthProvider>
  );
}
