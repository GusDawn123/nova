import type { Session } from '@supabase/supabase-js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { tabBarClearance } from '@/design/tab-bar-metrics';
import { cobaltPalette, paperPalette } from '@/design/tokens';
import { AppearanceProvider } from '@/hooks/use-appearance';
import type { UseAuth } from '@/hooks/use-auth';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import AccountScreen from '../app/(app)/(tabs)/account';

/**
 * Account — the quiet screen (spec §8).
 *
 * Everything here is a statement of fact about the user's account, so the tests are
 * about the two things that are NOT facts: the appearance row, which is a control
 * that has to survive a restart, and the destructive pair (sign out, delete), whose
 * wiring must come through the redesign untouched.
 *
 * The appearance row is the only place in the app where the theme can be changed, so
 * its persistence is not a nicety — a preference that does not come back is
 * indistinguishable from one that was never saved.
 */

const storage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: storage.getItem, setItem: storage.setItem },
}));

/** The OS says dark, so `auto` resolves to cobalt unless a pick overrides it. */
vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => 'dark',
}));

/** Native module, and unparseable by Node besides — see the stub's own note. */
vi.mock('react-native-safe-area-context', async () => {
  const { safeAreaStub } = await import('@/testing/safe-area-stub');
  return safeAreaStub();
});

const session = {
  access_token: 'token-abc',
  user: { email: 'ada@nova.test' },
} as unknown as Session;

const auth = vi.hoisted(() => ({
  status: 'signed-in' as UseAuth['status'],
  session: undefined as unknown,
  signOut: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => auth,
}));

vi.mock('@/hooks/use-health', () => ({
  useHealth: () => ({ status: 'success', data: { ok: true, version: '1.2.3' } }),
}));

vi.mock('@/hooks/use-me', () => ({
  useMe: () => ({
    status: 'success',
    data: { user_id: '11111111-1111-4111-8111-111111111111' },
  }),
}));

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  auth.status = 'signed-in';
  auth.session = session;
  auth.signOut.mockReset();
  auth.signOut.mockResolvedValue(undefined);
  storage.getItem.mockReset();
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockReset();
  storage.setItem.mockResolvedValue(undefined);
});

function renderAccount(): ReturnType<typeof render> {
  return render(
    <AppearanceProvider>
      <AccountScreen />
    </AppearanceProvider>,
  );
}

/** Let the mocked storage read land before asserting on hydrated state. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function colorOf(testID: string): string {
  return normaliseColor(getComputedStyle(screen.getByTestId(testID)).color);
}

const INK = normaliseColor(cobaltPalette.ink);

describe('AccountScreen — the facts', () => {
  it('says who is signed in, on what plan', async () => {
    renderAccount();
    await settle();

    expect(screen.getByTestId('signed-in-email')).toHaveTextContent('ada@nova.test');
    expect(screen.getByTestId('plan-chip')).toHaveTextContent('ACTIVE');
  });

  it('keeps the server and identity proofs it always carried', async () => {
    renderAccount();
    await settle();

    expect(screen.getByTestId('me-user-id')).toHaveTextContent(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument();
  });

  it('leaves the floating tab bar room to float over', async () => {
    // Account became a TAB in the last task of the redesign. The bar is absolutely
    // positioned and reserves no layout space, so without this padding the last
    // thing on the screen — DELETE ACCOUNT — sits underneath it, untappable.
    renderAccount();
    await settle();

    const content = screen.getByTestId('account-scroll').querySelector('div');
    if (content === null) throw new Error('expected a content container');

    expect(getComputedStyle(content).paddingBottom).toBe(`${tabBarClearance(0)}px`);
  });

  it('renders nothing at all without a session', async () => {
    auth.status = 'signed-out';
    auth.session = undefined;

    const { container } = renderAccount();
    await settle();

    expect(container).toBeEmptyDOMElement();
  });
});

describe('AccountScreen — appearance', () => {
  it('offers all three themes and marks the one in force', async () => {
    renderAccount();
    await settle();

    for (const label of ['COBALT', 'PAPER', 'AUTO']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Nothing saved yet, so the app is on auto.
    expect(colorOf('appearance-auto')).toBe(INK);
    expect(colorOf('appearance-paper')).not.toBe(INK);
  });

  it('cycles on press, and writes the pick down', async () => {
    renderAccount();
    await settle();

    act(() => {
      fireEvent.click(screen.getByTestId('appearance-row'));
    });

    expect(colorOf('appearance-cobalt')).toBe(INK);
    expect(storage.setItem).toHaveBeenCalledWith('nova.appearance', 'cobalt');
  });

  it('repaints the screen the moment the theme changes', async () => {
    // The row is not a label that updates — it is the whole app's palette. Paper
    // has to arrive on this screen too, or the setting is a lie about itself.
    storage.getItem.mockResolvedValue('paper');
    renderAccount();

    await waitFor(() => {
      expect(colorOf('appearance-paper')).toBe(normaliseColor(paperPalette.ink));
    });
    expect(
      normaliseColor(
        getComputedStyle(screen.getByTestId('account-screen')).backgroundColor,
      ),
    ).toBe(normaliseColor(paperPalette.canvas));
  });
});

describe('AccountScreen — leaving', () => {
  it('signs out through the auth layer', async () => {
    renderAccount();
    await settle();

    act(() => {
      fireEvent.click(screen.getByTestId('sign-out-button'));
    });

    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('asks twice before deleting anything', async () => {
    renderAccount();
    await settle();

    expect(screen.queryByTestId('delete-account-confirm')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('delete-account-button'));
    });

    expect(screen.getByTestId('delete-account-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('delete-account-cancel')).toBeInTheDocument();
  });
});

describe('AccountScreen — the duotone', () => {
  it('paints in ink and canvas only', async () => {
    const { container } = renderAccount();
    await settle();
    act(() => {
      fireEvent.click(screen.getByTestId('delete-account-button'));
    });

    // Including the delete flow, which is where a design reaches for red.
    expectDuotoneOnly(container, cobaltPalette);
  });
});
