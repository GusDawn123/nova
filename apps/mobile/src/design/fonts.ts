import {
  Inter_400Regular,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  Orbitron_700Bold,
  Orbitron_900Black,
} from '@expo-google-fonts/orbitron';
import {
  SpaceMono_400Regular,
  SpaceMono_700Bold,
} from '@expo-google-fonts/space-mono';
import {
  SplineSans_400Regular,
  SplineSans_500Medium,
  SplineSans_600SemiBold,
  useFonts,
} from '@expo-google-fonts/spline-sans';
import { SplineSansMono_400Regular } from '@expo-google-fonts/spline-sans-mono';

/**
 * The Nova typefaces.
 *
 * Two sets live here on purpose, for exactly as long as the redesign takes. The
 * trio — Orbitron for display, Inter for body, Space Mono for numerals and
 * machine-voice text — is what the new screens are drawn in. Spline Sans is what
 * the screens that have NOT been redrawn yet still name in `tokens.ts`; dropping
 * it now would fall those screens back to SF Pro mid-redesign. It retires in the
 * task that retires the last screen using it.
 *
 * Loaded at RUNTIME via `useFonts` rather than embedded through the `expo-font`
 * config plugin. The plugin produces a smaller, faster result, but it requires a
 * native rebuild — which means a custom dev build and CocoaPods, and would break the
 * Expo Go workflow the project runs on today. Worth revisiting when Phase 9's mic
 * capture forces a dev build anyway.
 *
 * The caller does NOT gate rendering on this. An unresolved `fontFamily` falls back
 * to the system face on both platforms, so the cost of rendering early is one frame
 * in SF Pro — cheaper than holding the splash on a network-free font decode, and far
 * cheaper than a blank screen if a font ever fails to load.
 */
export function useNovaFonts(): boolean {
  const [loaded] = useFonts({
    Orbitron_700Bold,
    Orbitron_900Black,
    Inter_400Regular,
    Inter_600SemiBold,
    Inter_700Bold,
    SpaceMono_400Regular,
    SpaceMono_700Bold,
    // Legacy — see the note above. Removed with the last Spline Sans screen.
    SplineSans_400Regular,
    SplineSans_500Medium,
    SplineSans_600SemiBold,
    SplineSansMono_400Regular,
  });
  return loaded;
}
