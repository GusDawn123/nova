import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useNovaFonts } from '@/design/fonts';
import { AppearanceProvider, useAppearance } from '@/hooks/use-appearance';
import { AuthProvider } from '@/hooks/use-auth';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout. `AuthProvider` wraps the whole tree so every route can read the
 * session, `AppearanceProvider` so every route paints the theme the user picked in
 * Account; the root `Stack` hosts the two route groups — `(auth)` (sign-in /
 * sign-up) and `(app)` (the tab navigator) — each of which guards itself.
 */
export default function RootLayout() {
  // The Nova typefaces. Deliberately NOT gated on: an unresolved
  // fontFamily falls back to the system face, so rendering early costs one frame in
  // SF Pro rather than a held splash — or a blank screen if a font fails to load.
  useNovaFonts();
  return (
    <AuthProvider>
      <AppearanceProvider>
        <ThemedStack />
      </AppearanceProvider>
    </AuthProvider>
  );
}

/**
 * The navigator, dressed in the resolved theme. Its own component because the
 * appearance can only be read from INSIDE the provider, and navigation's own theme
 * (which paints the gaps between screens during a transition) has to agree with the
 * one the screens paint — otherwise a push flashes the other theme's canvas.
 */
function ThemedStack() {
  const { theme } = useAppearance();

  return (
    <ThemeProvider value={theme === 'paper' ? DefaultTheme : DarkTheme}>
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  );
}
