import {
  SplineSans_400Regular,
  SplineSans_500Medium,
  SplineSans_600SemiBold,
  useFonts,
} from '@expo-google-fonts/spline-sans';
import { SplineSansMono_400Regular } from '@expo-google-fonts/spline-sans-mono';

/**
 * Spline Sans — the mock's typeface (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.1).
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
    SplineSans_400Regular,
    SplineSans_500Medium,
    SplineSans_600SemiBold,
    SplineSansMono_400Regular,
  });
  return loaded;
}
