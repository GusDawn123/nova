import { act, render, screen, waitFor } from '@testing-library/react';
import { Pressable, Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAND_BLUE, BRAND_WHITE } from '@/design/tokens';

import {
  APPEARANCE_STORAGE_KEY,
  AppearanceProvider,
  nextAppearance,
  resolveTheme,
  useAppearance,
  usePalette,
} from './use-appearance';

/**
 * The appearance override (spec §8 — "Appearance: Cobalt / Paper / Auto").
 *
 * Two halves, tested apart. The DECISIONS — which theme a choice resolves to, and
 * what the next choice is — are pure functions, so they need no renderer. The
 * PROVIDER exists for the one thing a pure function cannot do: survive a restart.
 * That is what most of the component tests here are about, because a preference
 * that does not come back is indistinguishable from one that was never saved.
 */

/** AsyncStorage is a native module; the tests own an in-memory one. */
const storage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: storage.getItem, setItem: storage.setItem },
}));

/** The OS preference, pinned so `auto` has a known answer. */
const os = vi.hoisted(() => ({ value: 'dark' as 'light' | 'dark' | null }));

vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => os.value,
}));

beforeEach(() => {
  os.value = 'dark';
  storage.getItem.mockReset();
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockReset();
  storage.setItem.mockResolvedValue(undefined);
});

/** Reads the context and cycles it — the Account row, reduced to its wiring. */
function Probe(): React.JSX.Element {
  const { choice, cycle, palette } = useAppearance();

  return (
    <Pressable testID="cycle" onPress={cycle}>
      <Text testID="choice">{choice}</Text>
      <Text testID="canvas">{palette.canvas}</Text>
    </Pressable>
  );
}

/** Reads only the palette — every screen in the app, reduced to its wiring. */
function PaletteProbe(): React.JSX.Element {
  const palette = usePalette();
  return <Text testID="canvas">{palette.canvas}</Text>;
}

/** Let the mocked storage promise land before asserting on hydrated state. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('nextAppearance', () => {
  it('cycles cobalt → paper → auto → cobalt', () => {
    // The row is one tappable label, so the cycle must close: a user who taps past
    // the one they wanted has to be able to keep tapping back to it.
    expect(nextAppearance('cobalt')).toBe('paper');
    expect(nextAppearance('paper')).toBe('auto');
    expect(nextAppearance('auto')).toBe('cobalt');
  });
});

describe('resolveTheme', () => {
  it('lets an explicit pick beat the OS', () => {
    expect(resolveTheme('paper', 'dark')).toBe('paper');
    expect(resolveTheme('cobalt', 'light')).toBe('cobalt');
  });

  it('follows the OS on auto, defaulting to cobalt when it says nothing', () => {
    expect(resolveTheme('auto', 'light')).toBe('paper');
    expect(resolveTheme('auto', 'dark')).toBe('cobalt');
    expect(resolveTheme('auto', null)).toBe('cobalt');
    expect(resolveTheme('auto', 'unspecified')).toBe('cobalt');
  });
});

describe('AppearanceProvider', () => {
  it('starts on auto and paints what the OS asked for', async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    await settle();

    expect(screen.getByTestId('choice')).toHaveTextContent('auto');
    expect(screen.getByTestId('canvas')).toHaveTextContent(BRAND_BLUE);
  });

  it('brings the saved pick back', async () => {
    // The whole point of the row: chosen once, still true after a restart — even
    // though the OS here is still saying dark.
    storage.getItem.mockResolvedValue('paper');

    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('choice')).toHaveTextContent('paper');
    });
    expect(screen.getByTestId('canvas')).toHaveTextContent(BRAND_WHITE);
    expect(storage.getItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY);
  });

  it('writes the pick down as it is made', async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    await settle();

    act(() => {
      screen.getByTestId('cycle').click();
    });

    expect(screen.getByTestId('choice')).toHaveTextContent('cobalt');
    expect(storage.setItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY, 'cobalt');
  });

  it('ignores a stored value it does not recognise', async () => {
    // Anything could be under that key — an older build, a hand-edited store. An
    // unparseable preference is no preference, not a crash and not a blank theme.
    storage.getItem.mockResolvedValue('midnight-neon');

    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    await settle();

    expect(screen.getByTestId('choice')).toHaveTextContent('auto');
    expect(screen.getByTestId('canvas')).toHaveTextContent(BRAND_BLUE);
  });

  it('does not let a slow storage read undo a pick already made', async () => {
    // The Account row is one tap away on the frame after mount, and the restore is
    // a round trip. Landing the stored value on top of a pick made in the meantime
    // would rewrite the user's choice in front of them, a beat after they made it.
    let answer: (value: string | null) => void = () => undefined;
    storage.getItem.mockReturnValue(
      new Promise<string | null>((resolve) => {
        answer = resolve;
      }),
    );

    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );

    act(() => {
      screen.getByTestId('cycle').click();
    });
    expect(screen.getByTestId('choice')).toHaveTextContent('cobalt');

    await act(async () => {
      answer('paper');
      await Promise.resolve();
    });

    expect(screen.getByTestId('choice')).toHaveTextContent('cobalt');
  });

  it('survives a storage that refuses to answer', async () => {
    storage.getItem.mockRejectedValue(new Error('no storage on this platform'));

    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    await settle();

    expect(screen.getByTestId('choice')).toHaveTextContent('auto');
  });
});

describe('usePalette', () => {
  it('takes its theme from the provider', async () => {
    storage.getItem.mockResolvedValue('paper');

    render(
      <AppearanceProvider>
        <PaletteProbe />
      </AppearanceProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('canvas')).toHaveTextContent(BRAND_WHITE);
    });
  });

  it('falls back to the OS when no provider is mounted', () => {
    // A palette read is cosmetic: a screen rendered outside the provider — in a test,
    // or in a tree not yet wired — must still paint, not throw.
    os.value = 'light';
    render(<PaletteProbe />);

    expect(screen.getByTestId('canvas')).toHaveTextContent(BRAND_WHITE);
  });
});

describe('useAppearance', () => {
  it('refuses to run outside the provider', () => {
    // Unlike a palette read, the CONTROL cannot degrade: a cycle that updates
    // nothing and saves nothing would look like it worked. That is a wiring bug,
    // and wiring bugs are loud here (same posture as `useAuth`).
    expect(() => render(<Probe />)).toThrow(/AppearanceProvider/);
  });
});
