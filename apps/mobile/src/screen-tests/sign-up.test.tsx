import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { View } from 'react-native';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette } from '@/design/tokens';
import type { MascotStageProps } from '@/features/mascot/mascot-stage';
import type { AuthActionResult, UseAuth } from '@/hooks/use-auth';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import SignUpScreen from '../app/(auth)/sign-up';

/**
 * Sign-up mirrors the front door (spec §8) — same identity block, same key, one
 * extra field. What is worth pinning is the thing the mirror ADDS: a confirm field
 * whose mismatch is caught here, before a round trip, and said the same way every
 * other error on this screen is said — plain copy and ink.
 */

/**
 * She is a box here — EXCEPT in the duotone case, which flips this flag before
 * rendering. She is the largest thing on the screen and she paints a glow gradient,
 * scanlines and tear layers; a colour guard run over a STUB of her is a guard over
 * the small print. Same arrangement as `sign-in.test.tsx`.
 */
const realMascot = vi.hoisted(() => ({ value: false }));

vi.mock('@/features/mascot/mascot-stage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/mascot/mascot-stage')>();
  return {
    MascotStage: (props: MascotStageProps) =>
      realMascot.value ? (
        <actual.MascotStage {...props} />
      ) : (
        <View testID="mascot-stage" style={{ width: props.size, height: props.size }} />
      ),
  };
});

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

vi.mock('expo-image', () => ({
  Image: ({
    style,
    tintColor,
    testID,
  }: {
    style?: unknown;
    tintColor?: string;
    testID?: string;
  }) => (
    // The tint is painted as a background so the duotone guard can SEE the colour
    // the real (native) Image would have tinted her ghosts with.
    <View
      testID={testID}
      style={[
        style as React.ComponentProps<typeof View>['style'],
        tintColor === undefined ? null : { backgroundColor: tintColor },
      ]}
    />
  ),
}));

/** Her motion is stubbed, not disabled: reduced motion removes half her tree. */
vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => false,
}));

vi.mock('expo-router', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <View testID={`link-${href}`}>{children}</View>
  ),
}));

const auth = vi.hoisted(() => ({
  status: 'signed-out' as UseAuth['status'],
  message: '',
  signUp: vi.fn<(email: string, password: string) => Promise<AuthActionResult>>(),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => auth,
}));

vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => 'dark',
}));

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  realMascot.value = false;
  auth.status = 'signed-out';
  auth.signUp.mockReset();
  auth.signUp.mockResolvedValue({ ok: true });
});

function fill(password: string, confirm: string): void {
  fireEvent.change(screen.getByTestId('email-input'), {
    target: { value: 'ada@nova.test' },
  });
  fireEvent.change(screen.getByTestId('password-input'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByTestId('confirm-input'), { target: { value: confirm } });
}

describe('SignUpScreen', () => {
  it('mirrors the front door, plus the confirm field', () => {
    render(<SignUpScreen />);

    expect(screen.getByTestId('mascot-stage')).toBeInTheDocument();
    expect(screen.getByText('NOVA')).toBeInTheDocument();
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-input')).toBeInTheDocument();
    expect(screen.getByText('CREATE ACCOUNT')).toBeInTheDocument();
    expect(screen.getByTestId('link-/sign-in')).toBeInTheDocument();
  });

  it('hides both password fields as they are typed', () => {
    render(<SignUpScreen />);

    expect(screen.getByTestId('password-input')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('confirm-input')).toHaveAttribute('type', 'password');
  });

  it('waits for all three fields before offering the key', () => {
    render(<SignUpScreen />);

    fireEvent.change(screen.getByTestId('email-input'), {
      target: { value: 'ada@nova.test' },
    });
    fireEvent.change(screen.getByTestId('password-input'), {
      target: { value: 'hunter2' },
    });

    expect(screen.getByTestId('submit-button')).toHaveAttribute('aria-disabled', 'true');
  });

  it('catches a mismatch here rather than at the server', async () => {
    render(<SignUpScreen />);
    fill('hunter2', 'hunter3');
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    expect(auth.signUp).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-error')).toHaveTextContent(/match/i);
  });

  it('marks the confirm field in ink, and nothing else changes colour', async () => {
    // The real mascot, not the box: she is the largest thing on this screen and the
    // only part of it that paints gradients, so a guard over her stub proves nothing
    // about the surface a user actually looks at.
    realMascot.value = true;
    const { container } = render(<SignUpScreen />);
    fill('hunter2', 'hunter3');
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('field-confirm').querySelector('polygon'),
      ).toHaveAttribute('stroke', cobaltPalette.ink);
    });
    expect(screen.getByTestId('field-email').querySelector('polygon')).toHaveAttribute(
      'stroke',
      cobaltPalette.inkHairline,
    );
    expectDuotoneOnly(container, cobaltPalette);
  });

  it('scrolls — this is the tall column, and the one a keyboard covers', () => {
    // Three fields plus her plus the wordmark is ~500pt before the keyboard takes
    // its ~290pt. Everything below the fold has to be reachable, which means the
    // column lives in a scroller rather than in a centred flex box.
    render(<SignUpScreen />);
    const scroller = screen.getByTestId('auth-scroll');

    expect(['auto', 'scroll']).toContain(getComputedStyle(scroller).overflowY);
    expect(scroller).toContainElement(screen.getByTestId('confirm-input'));
    expect(scroller).toContainElement(screen.getByTestId('submit-button'));
  });

  it('signs up once the two agree', async () => {
    render(<SignUpScreen />);
    fill('hunter2', 'hunter2');
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    expect(auth.signUp).toHaveBeenCalledWith('ada@nova.test', 'hunter2');
  });
});
