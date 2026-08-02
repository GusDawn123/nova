import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';
import { z } from 'zod';

import {
  paletteFor,
  paletteForTheme,
  themeForScheme,
  type ColorScheme,
  type Palette,
  type ThemeName,
} from '@/design/tokens';

/**
 * The appearance override — Cobalt, Paper, or whatever the OS says
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §8).
 *
 * The two themes are a brand decision, not an accessibility setting: cobalt is the
 * logo and paper is the logo inverted, and someone may want Nova blue on a phone
 * that runs light everywhere else. So the OS preference is the DEFAULT, not the
 * authority — `auto` follows it, and the other two choices outrank it.
 *
 * The choice lives in a context rather than a module-level store because it has to
 * re-render every screen that paints, and it persists through AsyncStorage so a
 * restart does not silently undo it.
 *
 * TWO hooks, deliberately asymmetric:
 *   - {@link usePalette} degrades. A palette read is cosmetic, and a screen mounted
 *     outside the provider — a test, a tree not yet wired — must still paint.
 *   - {@link useAppearance} throws. The CONTROL cannot degrade: a cycle that updates
 *     nothing and saves nothing looks like it worked. That is a wiring bug, and
 *     wiring bugs are loud here (the posture `useAuth` already takes).
 */

/** What the user picked. `auto` defers to the OS; the other two are explicit. */
export type AppearanceChoice = ThemeName | 'auto';

/** The cycle order of the Account row, and the order the labels are shown in. */
export const APPEARANCE_ORDER = ['cobalt', 'paper', 'auto'] as const;

export const APPEARANCE_STORAGE_KEY = 'nova.appearance';

/** The next choice in the cycle. Closes, so tapping past one can reach it again. */
export function nextAppearance(choice: AppearanceChoice): AppearanceChoice {
  const index = APPEARANCE_ORDER.indexOf(choice);
  return APPEARANCE_ORDER[(index + 1) % APPEARANCE_ORDER.length];
}

/**
 * Storage is a boundary, so it is PARSED (RULES §1) rather than hand-checked — and
 * the schema is built from {@link APPEARANCE_ORDER}, so a fourth theme cannot be
 * offered by the picker and rejected by the reader.
 */
const choiceSchema = z.enum(APPEARANCE_ORDER);

/** Anything else under the storage key is no preference — not a crash, not a blank. */
function parseChoice(stored: string | null): AppearanceChoice | null {
  const parsed = choiceSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** The theme actually painted: the explicit pick, or the OS's answer on `auto`. */
export function resolveTheme(
  choice: AppearanceChoice,
  scheme: ColorScheme,
): ThemeName {
  return choice === 'auto' ? themeForScheme(scheme) : choice;
}

export interface Appearance {
  choice: AppearanceChoice;
  /** The theme `choice` resolves to right now — `auto` reads the OS through this. */
  theme: ThemeName;
  palette: Palette;
  setChoice: (choice: AppearanceChoice) => void;
  /** Advance one step. The Account row is a single label, so this is its whole API. */
  cycle: () => void;
}

const AppearanceContext = createContext<Appearance | null>(null);

export function AppearanceProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const scheme = useColorScheme();
  // `auto` until storage answers. The read is a round trip, and starting anywhere
  // else would flash a theme the user did not choose before landing on the one they
  // did — so the first frame is the OS's answer, which is also the default.
  const [choice, setChoiceState] = useState<AppearanceChoice>('auto');
  // The restore is a round trip, and the Account row is one tap away on the frame
  // after mount. A pick made while storage is still answering must WIN — landing the
  // stored value on top of it would undo the user's tap in front of them.
  const chosen = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function restore(): Promise<void> {
      try {
        const stored = parseChoice(await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY));
        if (stored !== null && !cancelled && !chosen.current) {
          setChoiceState(stored);
        }
      } catch {
        // A storage that will not answer (web static render, a wiped store) leaves
        // the default standing. An unreadable preference is not worth a broken app.
      }
    }

    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  const setChoice = useCallback((next: AppearanceChoice) => {
    chosen.current = true;
    setChoiceState(next);
    // Fire and forget: the pick is already applied on screen, and a failed write
    // costs the user the preference on next launch, not this tap.
    void AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const value = useMemo<Appearance>(() => {
    const theme = resolveTheme(choice, scheme);
    return {
      choice,
      theme,
      palette: paletteForTheme(theme),
      setChoice,
      cycle: () => {
        setChoice(nextAppearance(choice));
      },
    };
  }, [choice, scheme, setChoice]);

  return (
    <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
  );
}

/** The control surface. Throws outside the provider — see the header. */
export function useAppearance(): Appearance {
  const value = useContext(AppearanceContext);
  if (value === null) {
    throw new Error('useAppearance must be used within an AppearanceProvider');
  }
  return value;
}

/**
 * The palette to paint with — the app-wide replacement for `paletteFor(useColorScheme())`.
 * Every screen reads its colours through here so one Account tap repaints all of them.
 */
export function usePalette(): Palette {
  const appearance = useContext(AppearanceContext);
  const scheme = useColorScheme();
  return appearance?.palette ?? paletteFor(scheme);
}
