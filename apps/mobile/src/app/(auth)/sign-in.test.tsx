import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { View } from 'react-native';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette } from '@/design/tokens';
import type { MascotStageProps } from '@/features/mascot/mascot-stage';
import type { AuthActionResult, UseAuth } from '@/hooks/use-auth';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import SignInScreen from './sign-in';

/**
 * The front door (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §8).
 *
 * This is the first thing anyone sees of Nova, and the only screen where the brand
 * has to carry the whole weight on its own — so the identity block is pinned here:
 * her, the wordmark, and what the app is for.
 *
 * The rest is the part a redesign quietly breaks. The key must stay INERT until
 * there is something to submit, the email must reach the auth layer trimmed, and a
 * rejection must come back as the server's own words in ink — never in a colour the
 * duotone does not have (spec §11).
 *
 * NOT proven here: that any of it is legible on a phone. jsdom has no layout.
 */

/**
 * She has her own suite, so she is a box here — EXCEPT in the duotone case, which
 * flips this flag before rendering. She is the largest thing on the screen and she
 * paints a glow gradient, scanlines and tear layers; a colour guard that runs over
 * a stub of her is a guard over the small print. The two native modules she needs
 * are stubbed below, exactly as `mascot-stage.test.tsx` stubs them.
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

/** `Link asChild` clones its child; the stub keeps the route readable instead. */
vi.mock('expo-router', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <View testID={`link-${href}`}>{children}</View>
  ),
}));

const auth = vi.hoisted(() => ({
  status: 'signed-out' as UseAuth['status'],
  message: '',
  signIn: vi.fn<(email: string, password: string) => Promise<AuthActionResult>>(),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => auth,
}));

/** No provider is mounted, so `usePalette` reads the OS — pinned to cobalt. */
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
  auth.message = '';
  auth.signIn.mockReset();
  auth.signIn.mockResolvedValue({ ok: true });
});

/** Type into both fields — the state the key is waiting for. */
function fillCredentials(email = '  ada@nova.test  ', password = 'hunter2'): void {
  fireEvent.change(screen.getByTestId('email-input'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('password-input'), { target: { value: password } });
}

describe('SignInScreen — the identity block', () => {
  it('leads with her, the wordmark, and what Nova is for', () => {
    render(<SignInScreen />);

    expect(screen.getByTestId('mascot-stage')).toBeInTheDocument();
    expect(screen.getByText('NOVA')).toBeInTheDocument();
    expect(screen.getByText('YOUR LIVE-CALL COPILOT')).toBeInTheDocument();
  });

  it('draws the double ring around her', async () => {
    // The ring is DRAWN — two nested circles — not part of her art, so it has to
    // exist in the tree rather than be assumed to arrive with the png.
    render(<SignInScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('mascot-ring-outer')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mascot-ring-inner')).toBeInTheDocument();
  });

  it('offers both fields and one key, and a way to the other screen', () => {
    render(<SignInScreen />);

    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
    expect(screen.getByTestId('submit-button')).toBeInTheDocument();
    expect(screen.getByText('SIGN IN')).toBeInTheDocument();
    expect(screen.getByTestId('link-/sign-up')).toBeInTheDocument();
  });

  it('keeps the password hidden as it is typed', () => {
    render(<SignInScreen />);

    expect(screen.getByTestId('password-input')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('email-input')).toHaveAttribute('type', 'email');
  });
});

describe('SignInScreen — submitting', () => {
  it('leaves the key inert until there is something to submit', () => {
    render(<SignInScreen />);
    const key = screen.getByTestId('submit-button');

    expect(key).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(key);
    expect(auth.signIn).not.toHaveBeenCalled();

    // One field is not enough either — an empty password is a round trip that can
    // only fail, and the key should not offer it.
    fireEvent.change(screen.getByTestId('email-input'), {
      target: { value: 'ada@nova.test' },
    });
    expect(key).toHaveAttribute('aria-disabled', 'true');
  });

  it('hands the auth layer a trimmed email and the password as typed', async () => {
    render(<SignInScreen />);
    fillCredentials();

    // react-native-web omits the attribute entirely when the control is live, so
    // "not disabled" is the absence of the flag rather than a `false` on it.
    expect(screen.getByTestId('submit-button')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    expect(auth.signIn).toHaveBeenCalledWith('ada@nova.test', 'hunter2');
  });

  it('explains itself when auth is not configured, and stays inert', () => {
    auth.status = 'unavailable';
    auth.message = 'Supabase config missing';

    render(<SignInScreen />);
    fillCredentials();

    expect(screen.getByText('Supabase config missing')).toBeInTheDocument();
    expect(screen.getByTestId('submit-button')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('SignInScreen — reachability', () => {
  it('puts the whole column in a scroller, key and footer included', () => {
    // Sign-up's column is ~500pt; a keyboard on a 667pt device covers the bottom
    // ~290pt of it. In a centred flex box the key and the footer would sit under
    // the keyboard with no way to reach them, and the overflow would CLIP rather
    // than scroll. Whether it is comfortable is a simulator check; that it can be
    // scrolled to at all is this one.
    render(<SignInScreen />);
    const scroller = screen.getByTestId('auth-scroll');

    expect(['auto', 'scroll']).toContain(getComputedStyle(scroller).overflowY);
    expect(scroller).toContainElement(screen.getByTestId('submit-button'));
    expect(scroller).toContainElement(screen.getByTestId('link-/sign-up'));
  });
});

describe('SignInScreen — a rejection', () => {
  it('says it in the server’s words, under the fields', async () => {
    auth.signIn.mockResolvedValue({
      ok: false,
      kind: 'invalid-credentials',
      message: 'Invalid login credentials',
    });

    render(<SignInScreen />);
    fillCredentials();
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    const error = screen.getByTestId('auth-error');
    expect(error).toHaveTextContent('Invalid login credentials');
    // Plain copy in secondary ink — the message carries the meaning, not a colour.
    expect(normaliseColor(getComputedStyle(error).color)).toBe(
      normaliseColor(cobaltPalette.inkSoft),
    );
  });

  it('answers with ink, never with a second colour', async () => {
    auth.signIn.mockResolvedValue({
      ok: false,
      kind: 'invalid-credentials',
      message: 'Invalid login credentials',
    });

    // Her included — glow gradient, scanlines, tear layers and all.
    realMascot.value = true;
    const { container } = render(<SignInScreen />);
    fillCredentials();
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    expect(screen.getByTestId('mascot-base')).toBeInTheDocument();
    // The rejected fields go to FULL ink — the emphasis the spec allows — while the
    // untouched ones stay at the resting hairline.
    await waitFor(() => {
      expect(
        screen.getByTestId('field-email').querySelector('polygon'),
      ).toHaveAttribute('stroke', cobaltPalette.ink);
    });
    expect(screen.getByTestId('field-password').querySelector('polygon')).toHaveAttribute(
      'stroke',
      cobaltPalette.ink,
    );
    expectDuotoneOnly(container, cobaltPalette);
  });

  it('rests every untouched field at the hairline', async () => {
    render(<SignInScreen />);

    await waitFor(() => {
      expect(
        screen.getByTestId('field-email').querySelector('polygon'),
      ).toHaveAttribute('stroke', cobaltPalette.inkHairline);
    });
  });

  it('clears the last failure when the next attempt starts', async () => {
    auth.signIn.mockResolvedValue({
      ok: false,
      kind: 'network',
      message: 'Network request failed',
    });

    render(<SignInScreen />);
    fillCredentials();
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });
    expect(screen.getByTestId('auth-error')).toBeInTheDocument();

    auth.signIn.mockResolvedValue({ ok: true });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-button'));
    });

    expect(screen.queryByTestId('auth-error')).toBeNull();
  });
});
