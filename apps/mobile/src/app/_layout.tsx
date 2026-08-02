import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useNovaFonts } from '@/design/fonts';
import { AuthProvider } from '@/hooks/use-auth';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout. `AuthProvider` wraps the whole tree so every route can read the
 * session; the root `Stack` hosts the two route groups — `(auth)` (sign-in /
 * sign-up) and `(app)` (the tab navigator) — each of which guards itself.
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();
  // Spline Sans, the mock's typeface. Deliberately NOT gated on: an unresolved
  // fontFamily falls back to the system face, so rendering early costs one frame in
  // SF Pro rather than a held splash — or a blank screen if a font fails to load.
  useNovaFonts();
  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <Stack screenOptions={{ headerShown: false }} />
      </ThemeProvider>
    </AuthProvider>
  );
}
