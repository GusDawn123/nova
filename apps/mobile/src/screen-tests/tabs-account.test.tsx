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

/**
 * The CONNECTION card's two reads, held as mutable test state rather than pinned to
 * success. Both of them fail in the field — an unreachable server, an expired token
 * — and a mock that can only succeed makes the card's other two branches unreachable
 * from here, which is where a redesign quietly drops them.
 */
const USER_ID = vi.hoisted(() => '11111111-1111-4111-8111-111111111111');

const connection = vi.hoisted(() => ({
  health: { status: 'success', message: '', data: { ok: true, version: '1.2.3' } } as {
    status: string;
    message: string;
    data?: { ok: boolean; version: string };
  },
  me: { status: 'success', message: '', data: { user_id: USER_ID } } as {
    status: string;
    message: string;
    data?: { user_id: string };
  },
}));

vi.mock('@/hooks/use-health', () => ({
  useHealth: () => connection.health,
}));

vi.mock('@/hooks/use-me', () => ({
  useMe: () => connection.me,
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
  connection.health = {
    status: 'success',
    message: '',
    data: { ok: true, version: '1.2.3' },
  };
  connection.me = { status: 'success', message: '', data: { user_id: USER_ID } };
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
  it('says who is signed in — and shows a plan chip that is still a placeholder', async () => {
    renderAccount();
    await settle();

    expect(screen.getByTestId('signed-in-email')).toHaveTextContent('ada@nova.test');
    // NOT billing coverage. `/me` carries no plan tier yet (CLAUDE.md, spec §10's
    // wire workstream), so ACTIVE is a fixed string this screen can prove nothing
    // about. This pins the current SHAPE; when the tier lands on the wire, the
    // assertion has to be driven from the hook or it becomes a lie about a lie.
    expect(screen.getByTestId('plan-chip')).toHaveTextContent('ACTIVE');
  });

  it('keeps the server and identity proofs it always carried', async () => {
    renderAccount();
    await settle();

    expect(screen.getByTestId('me-user-id')).toHaveTextContent(USER_ID);
    expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument();
  });

  it('says a failed connection out loud instead of leaving a blank card', async () => {
    // Both reads fail in the field, and neither may render as nothing: an empty
    // CONNECTION card is indistinguishable from one that is still loading.
    connection.health = { status: 'error', message: 'network request failed' };
    connection.me = { status: 'error', message: 'token expired' };

    renderAccount();
    await settle();

    expect(screen.getByText(/server unreachable/)).toBeInTheDocument();
    expect(screen.getByText(/network request failed/)).toBeInTheDocument();
    expect(screen.getByText(/\/me failed/)).toBeInTheDocument();
    expect(screen.getByText(/token expired/)).toBeInTheDocument();
    // And the rest of the screen is untouched: a failed proof is not a failed
    // account, so signing out and deleting must both still be reachable.
    expect(screen.getByTestId('sign-out-button')).toBeInTheDocument();
    expect(screen.getByTestId('delete-account-button')).toBeInTheDocument();
  });

  it('says it is still asking, rather than saying nothing', async () => {
    connection.health = { status: 'loading', message: '' };
    connection.me = { status: 'loading', message: '' };

    renderAccount();
    await settle();

    expect(screen.getByText('checking server…')).toBeInTheDocument();
    expect(screen.getByText('verifying identity…')).toBeInTheDocument();
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

  it('brings the pick back through a restart, whatever it wrote down', async () => {
    // The ROUND TRIP, not two independent literals: whatever the writer emitted is
    // exactly what the next cold start is handed. Seeding the reader by hand would
    // let the two halves of the preference drift apart and both tests stay green.
    const first = renderAccount();
    await settle();
    act(() => {
      fireEvent.click(screen.getByTestId('appearance-row'));
    });

    const [key, written] = storage.setItem.mock.calls.at(-1) ?? [];
    expect(key).toBe('nova.appearance');
    first.unmount();

    storage.getItem.mockResolvedValue(written ?? null);
    renderAccount();

    await waitFor(() => {
      expect(colorOf('appearance-cobalt')).toBe(INK);
    });
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
