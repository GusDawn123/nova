import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette } from '@/design/tokens';
import { expectDuotoneOnly } from '@/testing/duotone';

import { LoadingList } from './loading-list';

/**
 * The loading skeletons (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * Two things are worth pinning: that the wait is card-SHAPED (three of them, so the
 * list does not jump when it lands), and that reduced motion removes the moving
 * highlight rather than parking it somewhere along the bar, where it would read as a
 * stalled progress indicator — the same posture `LightSweep` takes with its band.
 */
vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * jsdom has no `window.matchMedia`, and react-native-web's `AccessibilityInfo`
 * answers `isReduceMotionEnabled()` with TRUE when it cannot ask — so the sheen would
 * be absent here for a reason that has nothing to do with the component.
 *
 * NOTE the reach of this mock: it drives the `useReducedMotion` this file's component
 * imports, and NOT the one `useShimmer` calls inside `design/motion.ts` itself. That
 * is why the assertions below read the TREE rather than the `withRepeat` spy.
 */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

beforeEach(() => {
  reduced.value = false;
});

describe('LoadingList', () => {
  it('holds three card-shaped places, each with its bars', () => {
    render(<LoadingList palette={cobaltPalette} />);

    expect(screen.getAllByTestId(/^skeleton-card-/)).toHaveLength(3);
    expect(screen.getAllByTestId('skeleton-sheen')).toHaveLength(6);
  });

  it('keeps the bars and drops the shimmer when motion is off', () => {
    reduced.value = true;

    render(<LoadingList palette={cobaltPalette} />);

    expect(screen.getAllByTestId(/^skeleton-card-/)).toHaveLength(3);
    expect(screen.queryByTestId('skeleton-sheen')).toBeNull();
  });

  it('waits in ink and canvas only, in either theme', () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = render(<LoadingList palette={palette} />);

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
