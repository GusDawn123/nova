import { liveModeSchema } from '@nova/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { ModePicker } from './mode-picker';

/**
 * The mode pills. Mode is per CALL — picked before starting, then locked — so the
 * two things worth pinning are that every wire mode is reachable and that the row
 * goes inert once a session is in flight.
 *
 * The redesign adds a third: the picked pill is INK-FILLED (spec §4). The duotone
 * has one ink, so a selected state cannot be a lighter shade of anything — fill and
 * its inverse text is the only contrast available, and a re-skin that reaches for a
 * tint has left the palette.
 */

beforeAll(() => {
  installLayoutStub();
});

function renderPicker(
  props: Partial<React.ComponentProps<typeof ModePicker>> = {},
  palette: Palette = cobaltPalette,
) {
  return render(
    <ModePicker
      mode="general"
      onSelect={() => undefined}
      disabled={false}
      palette={palette}
      {...props}
    />,
  );
}

describe('ModePicker', () => {
  it('offers every wire mode, with the picked one marked', () => {
    renderPicker();

    for (const mode of liveModeSchema.options) {
      expect(screen.getByTestId(`mode-pill-${mode}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('mode-pill-general')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('mode-pill-technical')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('reports the pick to its owner (the hook holds the state)', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    fireEvent.click(screen.getByTestId('mode-pill-technical'));

    expect(onSelect).toHaveBeenCalledWith('technical');
  });

  it('is inert while a session is in flight', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect, disabled: true });

    fireEvent.click(screen.getByTestId('mode-pill-finance'));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId('mode-pill-finance')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('fills the picked pill with ink and writes on it in canvas', async () => {
    renderPicker({ mode: 'finance' });

    await waitFor(() => {
      expect(screen.getByTestId('mode-pill-finance').querySelector('polygon'))
        .not.toBeNull();
    });
    const filled = screen
      .getByTestId('mode-pill-finance')
      .querySelector('polygon');
    expect(filled).toHaveAttribute('fill', cobaltPalette.ink);
    expect(
      normaliseColor(getComputedStyle(screen.getByText('Finance')).color),
    ).toBe(normaliseColor(cobaltPalette.onInk));
  });

  it('paints in ink and canvas only, in either theme', async () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = renderPicker({}, palette);
      await waitFor(() => {
        expect(container.querySelector('polygon')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
