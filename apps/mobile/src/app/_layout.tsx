import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';

import { useNovaFonts } from '@/design/fonts';
import { AppearanceProvider, useAppearance } from '@/hooks/use-appearance';
import { AuthProvider } from '@/hooks/use-auth';

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
 *
 * NOTHING sits between the native splash and this navigator. The Expo template's
 * `AnimatedSplashOverlay` used to — a full-screen template-blue slab holding the Expo
 * logo, which made a third colour the app's literal first frame on every cold start
 * (spec §11: one blue, one white, nothing else). It is deleted, along with the
 * `preventAutoHideAsync` it existed to undo, so `expo-splash-screen` auto-hides on
 * the first commit and hands straight off to `(app)/_layout`'s in-brand waiting
 * frame. `app.json` paints the native launch screen `#0002DA` for the same reason.
 */
function ThemedStack() {
  const { theme } = useAppearance();

  return (
    <ThemeProvider value={theme === 'paper' ? DefaultTheme : DarkTheme}>
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  );
}
