import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { StateCard, type StateCardProps } from './state-card';

/**
 * The one card every "there is nothing here, and this is why" state is drawn as
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5, §11).
 *
 * The design decision this file protects is that a WAIT and a FAILURE look alike and
 * read differently. There is no alarm colour, so nothing about a failure may be
 * louder than an admission — which leaves exactly two things that must differ, and
 * both of them are structural rather than chromatic:
 *
 *   - the ring orbit, which is the indicator for a non-live WAIT, and must never
 *     turn beside a state that is not waiting for anything;
 *   - the key, which is drawn only when a press can actually change something.
 *
 * A retry offered on a dead end is worse than no key at all, so its absence is
 * asserted as deliberately as its presence.
 */

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/** jsdom has no `matchMedia`; the ring's loop is gated from here instead. */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

const onPress = vi.fn<() => void>();

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  reduced.value = false;
  onPress.mockReset();
});

function renderCard(
  overrides: Partial<StateCardProps> = {},
  palette: Palette = cobaltPalette,
) {
  return render(
    <StateCard
      palette={palette}
      testID="state-card"
      eyebrow="NOTES"
      message="The notes didn't come out."
      {...overrides}
    />,
  );
}

describe('StateCard — what it says', () => {
  it('carries the eyebrow and the sentence', () => {
    renderCard();

    expect(screen.getByTestId('state-card')).toBeInTheDocument();
    expect(screen.getByText('NOTES')).toBeInTheDocument();
    expect(screen.getByText("The notes didn't come out.")).toBeInTheDocument();
  });

  it('omits the quieter second line rather than drawing an empty one', () => {
    const { rerender } = renderCard();
    expect(screen.queryByText('Nothing else to say.')).toBeNull();

    rerender(
      <StateCard
        palette={cobaltPalette}
        testID="state-card"
        eyebrow="NOTES"
        message="The notes didn't come out."
        detail="Nothing else to say."
      />,
    );
    expect(screen.getByText('Nothing else to say.')).toBeInTheDocument();
  });
});

describe('StateCard — the key', () => {
  it('draws no key at all when nothing a press can change', () => {
    // A dead end with a button on it is a promise the state cannot keep.
    renderCard();

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws the key, and hands the press straight through', () => {
    renderCard({
      action: { label: 'TRY AGAIN', onPress, testID: 'state-card-retry' },
    });

    fireEvent.click(screen.getByTestId('state-card-retry'));

    expect(screen.getByText('TRY AGAIN')).toBeInTheDocument();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('StateCard — the wait', () => {
  it('turns the ring only for a state that is actually waiting', async () => {
    const { rerender } = renderCard({ waiting: true });
    await waitFor(() => {
      expect(screen.getByTestId('ring-orbit-rotor')).toBeInTheDocument();
    });

    // A failure is not waiting for anything, so the same card shows no indicator.
    rerender(
      <StateCard
        palette={cobaltPalette}
        testID="state-card"
        eyebrow="NOTES"
        message="The notes didn't come out."
      />,
    );

    expect(screen.queryByTestId('ring-orbit-rotor')).toBeNull();
  });
});

describe('StateCard — the duotone', () => {
  it('paints in ink and canvas only, in either theme', async () => {
    // Both halves of the card that can reach for a colour: the chamfered key's
    // polygon and the ring's two circles. The failure state is the classic place a
    // third colour arrives (spec §11), and this card IS the failure state.
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = render(
        <StateCard
          palette={palette}
          testID="state-card"
          eyebrow="NOTES"
          message="The notes didn't come out."
          detail="Something went wrong while writing them."
          waiting
          action={{ label: 'TRY AGAIN', onPress }}
        />,
      );

      // The chamfer draws on the second frame, off its measured box — asserting
      // before it lands would guard an empty tree.
      await waitFor(() => {
        expect(container.querySelector('polygon')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
