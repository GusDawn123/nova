import { render, screen } from '@testing-library/react';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordDotColor } from '@/design/tab-bar-metrics';
import { cobaltPalette, paperPalette } from '@/design/tokens';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import AppTabs from './app-tabs';

/**
 * The tab bar (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5, and the
 * gallery mockup's bottom rail: `▤ MEETINGS` / `◉ LIVE` / `◌ ACCOUNT` in
 * letter-spaced mono, the current one at full strength).
 *
 * WHAT THIS SUITE CANNOT SEE. `expo-router/ui` is stubbed, so the one structural
 * rule this file lives under is NOT exercised here: `TabList` discovers the
 * navigator's screens by scanning its child ELEMENTS for `TabTrigger` before
 * anything renders, which is why the triggers are direct children of the bar and
 * why the bar takes them as `children` rather than drawing them itself. Break that
 * and the app throws "Couldn't find any screens" at runtime while this suite stays
 * green — it is a simulator/`expo start` check, not a unit one.
 *
 * What IS asserted is everything the stub does not fake: which tabs exist for which
 * role, the words and glyphs on them, the selected state a screen reader reads, the
 * record dot's contrast against whatever it sits on, and that the bar is painted in
 * the duotone rather than in the retired glass tokens.
 */

/** Which trigger the stubbed navigator reports as current. */
const focusedTab = vi.hoisted(() => ({ name: 'index' }));

/**
 * The navigator, faked down to the two things the bar asks of it: `TabList` hands
 * its props to the bar (`asChild`), and each `TabTrigger` clones its child with
 * `isFocused`. Everything else — routing, state, the child scan above — is the real
 * library's job and is not simulated.
 */
vi.mock('expo-router/ui', () => {
  type SlotChild = ReactElement<{ isFocused?: boolean }>;

  return {
    Tabs: ({ children }: { children: ReactNode }) => <>{children}</>,
    TabSlot: () => null,
    TabList: ({ children }: { children: ReactNode }) => <>{children}</>,
    TabTrigger: ({ name, children }: { name: string; children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as SlotChild, {
            isFocused: name === focusedTab.name,
          })
        : null,
  };
});

vi.mock('react-native-safe-area-context', async () => {
  const { safeAreaStub } = await import('@/testing/safe-area-stub');
  return safeAreaStub();
});

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/** jsdom cannot answer `matchMedia`, so reduced motion is driven from here. */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

/** The Live tab is role-gated; `useRole` has its own suite. */
const role = vi.hoisted(() => ({ value: 'developer' as 'developer' | 'customer' }));

vi.mock('@/hooks/use-role', () => ({ useRole: () => role.value }));

/** No provider is mounted, so `usePalette` reads the OS — flipped per test. */
const scheme = vi.hoisted(() => ({ value: 'dark' as 'dark' | 'light' }));

vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => scheme.value,
}));

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  focusedTab.name = 'index';
  reduced.value = false;
  role.value = 'developer';
  scheme.value = 'dark';
});

function styleOf(testID: string): CSSStyleDeclaration {
  return getComputedStyle(screen.getByTestId(testID));
}

describe('AppTabs — the three rooms', () => {
  it('names them in mono, glyph first, in the mockup order', () => {
    render(<AppTabs />);

    const labels = screen
      .getAllByRole('tab')
      .map((tab) => tab.textContent?.trim() ?? '');

    expect(labels).toEqual(['▤ MEETINGS', '◉ LIVE', '◌ ACCOUNT']);
  });

  it('reads the plain word to a screen reader, not the glyph', () => {
    // The glyphs are decoration. `◌ ACCOUNT` announced literally is noise, and
    // most screen readers say nothing at all for a dotted-circle character.
    render(<AppTabs />);

    for (const name of ['Meetings', 'Live', 'Account']) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
  });

  it('gives a customer no Live tab at all', () => {
    // Not hidden — absent. `expo-router/ui` drops the route with the trigger, so
    // a customer cannot reach `/live` by any means until Phase 9.
    role.value = 'customer';
    render(<AppTabs />);

    const labels = screen
      .getAllByRole('tab')
      .map((tab) => tab.textContent?.trim() ?? '');

    expect(labels).toEqual(['▤ MEETINGS', '◌ ACCOUNT']);
  });

  it('keeps Account reachable as a tab of its own', () => {
    // It used to be a key in the Meetings header — the only route into it. This is
    // that bridge's replacement, so its absence is a dead end, not a cosmetic loss.
    render(<AppTabs />);

    expect(screen.getByTestId('tab-account')).toBeInTheDocument();
  });
});

describe('AppTabs — which one is current', () => {
  it('marks exactly one selected, for both channels', () => {
    focusedTab.name = 'live';
    render(<AppTabs />);

    const selected = screen
      .getAllByRole('tab')
      .filter((tab) => tab.getAttribute('aria-selected') === 'true');

    expect(selected).toHaveLength(1);
    expect(selected[0].textContent?.trim()).toBe('◉ LIVE');
  });

  it('fills the current tab with full ink and its label with the canvas colour', () => {
    // The duotone has one ink: "selected" cannot be a lighter shade of anything, so
    // it is a fill and its inverse — the same move the meeting-detail tabs make.
    render(<AppTabs />);

    expect(normaliseColor(styleOf('tab-index').backgroundColor)).toBe(
      normaliseColor(cobaltPalette.ink),
    );
    expect(normaliseColor(styleOf('tab-label-index').color)).toBe(
      normaliseColor(cobaltPalette.onInk),
    );
  });

  it('leaves the others unfilled, above the contrast floor', () => {
    render(<AppTabs />);

    const resting = styleOf('tab-live');
    expect(resting.backgroundColor === '' || resting.backgroundColor === 'rgba(0, 0, 0, 0)').toBe(
      true,
    );
    // `inkSoft`, not `inkFaint`: an unselected tab is still a destination the user
    // has to be able to read (spec §11's ≥65% floor).
    expect(normaliseColor(styleOf('tab-label-live').color)).toBe(
      normaliseColor(cobaltPalette.inkSoft),
    );
  });
});

describe('AppTabs — the bar itself', () => {
  it('is a canvas slab with a hairline edge, not a glass pill', () => {
    // Canvas, and opaque: the bar floats over a scrolling list, and a translucent
    // fill would let rows smear through it. The hairline is what makes it a surface.
    render(<AppTabs />);

    const bar = styleOf('tab-bar');
    expect(normaliseColor(bar.backgroundColor)).toBe(
      normaliseColor(cobaltPalette.canvas),
    );
    expect(normaliseColor(bar.borderTopColor)).toBe(
      normaliseColor(cobaltPalette.inkHairline),
    );
  });

  it('mirrors into paper', () => {
    scheme.value = 'light';
    render(<AppTabs />);

    expect(normaliseColor(styleOf('tab-bar').backgroundColor)).toBe(
      normaliseColor(paperPalette.canvas),
    );
  });

  it('paints in ink and canvas only', () => {
    const { container } = render(<AppTabs />);

    expectDuotoneOnly(container, cobaltPalette);
  });
});

describe('AppTabs — the record dot', () => {
  it('rides the Live tab and nothing else', () => {
    render(<AppTabs />);

    expect(screen.getAllByTestId('record-dot')).toHaveLength(1);
    expect(screen.getByTestId('tab-live')).toContainElement(
      screen.getByTestId('record-dot'),
    );
  });

  it('flips colour with focus, so it never vanishes into what it sits on', () => {
    focusedTab.name = 'live';
    render(<AppTabs />);

    expect(normaliseColor(styleOf('record-dot').backgroundColor)).toBe(
      normaliseColor(recordDotColor(cobaltPalette, true)),
    );
  });

  it('takes full ink on the unfocused tab, against the bar canvas', () => {
    render(<AppTabs />);

    expect(normaliseColor(styleOf('record-dot').backgroundColor)).toBe(
      normaliseColor(recordDotColor(cobaltPalette, false)),
    );
  });
});
