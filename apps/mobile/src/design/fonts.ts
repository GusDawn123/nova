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
import { useFonts } from 'expo-font';

/**
 * The Nova typefaces: Orbitron for display, Inter for body, Space Mono for numerals
 * and machine-voice text (spec §2). One trio, and only this trio — Spline Sans rode
 * along through the redesign so the not-yet-redrawn screens would not fall back to
 * SF Pro mid-flight, and retired with the last of them.
 *
 * `useFonts` comes from `expo-font` rather than from one of the font packages. The
 * `@expo-google-fonts/*` packages all re-export the same hook, so importing it from
 * one of them works — right up until that package is the one being uninstalled, at
 * which point the app loses its font loading along with a face nothing was using.
 * Naming the real owner makes the packages what they are: face data, nothing else.
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
  });
  return loaded;
}
