import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette } from '@/design/tokens';
import { APPEARANCE_STORAGE_KEY } from '@/hooks/use-appearance';

import RootLayout from '../app/_layout';

/**
 * The root layout — the tree everything else hangs off, and the first thing on
 * screen after the native splash lets go.
 *
 * That last part is new. The Expo template's `AnimatedSplashOverlay` used to cover
 * this navigator at `zIndex: 1000` through the whole cold-start handoff, so what the
 * root `Stack` painted underneath never mattered. With the overlay deleted (it was
 * the app's only third colour, and its own first frame), it does: an unset
 * `contentStyle` leaves React Navigation's `theme.colors.background` — near-black on
 * Dark, near-white on Default — as the thing on screen until the first route paints.
 *
 * Like `app-layout.test.tsx`, this is a navigator OPTION, which means it is invisible
 * in every other test in this repo and deletable without a single failure.
 */

const stackProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
const navigationTheme = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('expo-router', () => ({
  Stack: (props: Record<string, unknown>) => {
    stackProps.value = props;
    return null;
  },
  ThemeProvider: ({ value, children }: { value: unknown; children: ReactNode }) => {
    navigationTheme.value = value;
    return children;
  },
  DarkTheme: { name: 'DarkTheme' },
  DefaultTheme: { name: 'DefaultTheme' },
}));

/** Loading real font files is a native concern and not what this file is about. */
vi.mock('@/design/fonts', () => ({ useNovaFonts: () => undefined }));

/** The session is irrelevant here — the route groups guard themselves. */
vi.mock('@/hooks/use-auth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

/**
 * The appearance provider is REAL: the whole question is which palette reaches the
 * navigator, and a stubbed provider would answer it by assumption. Only its native
 * dependencies are replaced — AsyncStorage, and the OS scheme `auto` resolves through.
 */
const storage = vi.hoisted(() => ({
  value: null as string | null,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (): Promise<string | null> => Promise.resolve(storage.value),
    setItem: (): Promise<void> => Promise.resolve(),
  },
}));

const os = vi.hoisted(() => ({ value: 'dark' as 'light' | 'dark' }));

vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => os.value,
}));

beforeEach(() => {
  stackProps.value = null;
  navigationTheme.value = null;
  storage.value = null;
  os.value = 'dark';
});

function screenOptions(): Record<string, unknown> {
  const props = stackProps.value;
  if (props === null) throw new Error('the stack never rendered');
  return props.screenOptions as Record<string, unknown>;
}

describe('RootLayout', () => {
  it('draws no header of its own', () => {
    render(<RootLayout />);

    expect(screenOptions().headerShown).toBe(false);
  });

  it('backs the navigator with the canvas rather than the platform default', () => {
    // Nothing covers this navigator any more, so an unset `contentStyle` is what a
    // cold start would show: React Navigation's own `rgb(1,1,1)`.
    render(<RootLayout />);

    expect(screenOptions().contentStyle).toEqual({
      backgroundColor: cobaltPalette.canvas,
    });
  });

  it('brings a stored pick back to the navigator, not just to the screens', async () => {
    // Both halves of the same claim: the navigation theme and the backdrop have to
    // move TOGETHER, or the gap between screens is the other theme's canvas.
    storage.value = 'paper';

    render(<RootLayout />);

    await waitFor(() => {
      expect(screenOptions().contentStyle).toEqual({
        backgroundColor: paperPalette.canvas,
      });
    });
    expect(navigationTheme.value).toEqual({ name: 'DefaultTheme' });
  });

  it('repaints that backing when the theme changes UNDER it', async () => {
    // A restore is one initial value; this is the transition. On `auto` the OS is
    // the authority, so the phone switching to light mid-session has to carry both
    // the backdrop and the navigation theme across with it — the failure otherwise
    // is a cobalt flash in the gap between two paper screens.
    const { rerender } = render(<RootLayout />);
    expect(screenOptions().contentStyle).toEqual({
      backgroundColor: cobaltPalette.canvas,
    });
    expect(navigationTheme.value).toEqual({ name: 'DarkTheme' });

    os.value = 'light';
    rerender(<RootLayout />);

    await waitFor(() => {
      expect(screenOptions().contentStyle).toEqual({
        backgroundColor: paperPalette.canvas,
      });
    });
    expect(navigationTheme.value).toEqual({ name: 'DefaultTheme' });
  });

  it('follows the OS when nothing was ever picked', () => {
    // `auto` is the default, and the stored key is what overrides it.
    os.value = 'light';

    render(<RootLayout />);

    expect(screenOptions().contentStyle).toEqual({
      backgroundColor: paperPalette.canvas,
    });
    expect(navigationTheme.value).toEqual({ name: 'DefaultTheme' });
  });
});

describe('the storage key the layout restores through', () => {
  it('is the one Account writes', () => {
    // Not an assertion about this file so much as a tripwire under it: the provider
    // above is the real one, so a renamed key would silently stop restoring.
    expect(APPEARANCE_STORAGE_KEY).toBe('nova.appearance');
  });
});
