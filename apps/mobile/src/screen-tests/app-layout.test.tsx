import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette } from '@/design/tokens';
import type { UseAuth } from '@/hooks/use-auth';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';

import AppLayout from '../app/(app)/_layout';

/**
 * The authenticated shell — the guard, the waiting frame, and how one screen
 * becomes the next.
 *
 * The transition is the part worth pinning. It is a navigator OPTION, which means
 * it is invisible in every other test in this repo and deletable without a single
 * failure: the app would simply go back to sliding, and nobody would find out until
 * someone looked closely at a push on a device.
 */

const stackProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
const redirectedTo = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('expo-router', () => ({
  Stack: (props: Record<string, unknown>) => {
    stackProps.value = props;
    return null;
  },
  Redirect: ({ href }: { href: string }) => {
    redirectedTo.value = href;
    return null;
  },
}));

vi.mock('react-native-safe-area-context', async () => {
  const { safeAreaStub } = await import('@/testing/safe-area-stub');
  return safeAreaStub();
});

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

const auth = vi.hoisted(() => ({ status: 'loading' as UseAuth['status'] }));

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));

/** No provider is mounted, so `usePalette` reads the OS. */
vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => 'dark',
}));

beforeEach(() => {
  auth.status = 'loading';
  reduced.value = false;
  stackProps.value = null;
  redirectedTo.value = null;
});

function screenOptions(): Record<string, unknown> {
  const props = stackProps.value;
  if (props === null) throw new Error('the stack never rendered');
  return props.screenOptions as Record<string, unknown>;
}

describe('AppLayout — the guard', () => {
  it('waits in brand while the session resolves', () => {
    const { container } = render(<AppLayout />);

    expect(screen.getByTestId('app-waiting')).toBeInTheDocument();
    expect(
      normaliseColor(getComputedStyle(screen.getByTestId('app-waiting')).backgroundColor),
    ).toBe(normaliseColor(cobaltPalette.canvas));
    expectDuotoneOnly(container as HTMLElement, cobaltPalette);
  });

  it('sends anyone without a session to the front door', () => {
    auth.status = 'signed-out';
    render(<AppLayout />);

    expect(redirectedTo.value).toBe('/sign-in');
    expect(stackProps.value).toBeNull();
  });

  it('renders the app only for a real session', () => {
    auth.status = 'signed-in';
    render(<AppLayout />);

    expect(stackProps.value).not.toBeNull();
    expect(redirectedTo.value).toBeNull();
  });
});

describe('AppLayout — how one screen becomes the next', () => {
  function renderSignedIn(): ReactNode {
    auth.status = 'signed-in';
    render(<AppLayout />);
    return null;
  }

  it('cross-fades rather than sliding', () => {
    renderSignedIn();

    expect(screenOptions().animation).toBe('fade');
  });

  it('takes 200ms over it', () => {
    renderSignedIn();

    expect(screenOptions().animationDuration).toBe(200);
  });

  it('still draws no header, and fades over the canvas rather than through it', () => {
    // A transparent backdrop would let React Navigation's theme background show
    // through at the fade's midpoint — near-black on Dark, near-white on Default.
    // The screens paint `palette.canvas` anyway, so an opaque canvas here can never
    // differ from what is on top of it.
    renderSignedIn();

    expect(screenOptions().headerShown).toBe(false);
    expect(screenOptions().contentStyle).toEqual({
      backgroundColor: cobaltPalette.canvas,
    });
  });
});
