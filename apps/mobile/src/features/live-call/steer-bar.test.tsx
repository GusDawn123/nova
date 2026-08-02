import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { STEER_PLACEHOLDER, SteerBar } from './steer-bar';

/**
 * The bottom bar: the steer field and the one key (spec §3, §4).
 *
 * On the MVP wire the key is only live when the field has something in it — the
 * bridge rides `transcript.input`, which carries text or nothing at all (spec §10).
 * So "disabled when empty" is not styling, it is the contract, and it is the first
 * thing a rewrite of this bar would break.
 */

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

const onRespond = vi.fn<(steer: string) => void>();

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  onRespond.mockReset();
});

function renderBar(canSend = true, palette: Palette = cobaltPalette) {
  return render(
    <SteerBar palette={palette} canSend={canSend} onRespond={onRespond} />,
  );
}

describe('SteerBar', () => {
  it('offers the steer field with the spec’s invitation', () => {
    renderBar();

    expect(screen.getByTestId('steer-field')).toHaveAttribute(
      'placeholder',
      STEER_PLACEHOLDER,
    );
  });

  it('keeps the key dead while the field is empty', () => {
    renderBar();

    expect(screen.getByTestId('respond-key')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(screen.getByTestId('respond-key'));
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('stays dead for whitespace, which is not a steer', () => {
    renderBar();

    fireEvent.change(screen.getByTestId('steer-field'), {
      target: { value: '   ' },
    });

    expect(screen.getByTestId('respond-key')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('sends what was typed, then empties the field', () => {
    renderBar();
    const field = screen.getByTestId('steer-field');

    fireEvent.change(field, { target: { value: 'push on the timeline' } });
    fireEvent.click(screen.getByTestId('respond-key'));

    expect(onRespond).toHaveBeenCalledWith('push on the timeline');
    expect(field).toHaveValue('');
  });

  it('is dead altogether when the session cannot take input', () => {
    renderBar(false);

    fireEvent.change(screen.getByTestId('steer-field'), {
      target: { value: 'push on the timeline' },
    });

    expect(screen.getByTestId('respond-key')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(screen.getByTestId('respond-key'));
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('brackets the field while it has focus', async () => {
    const { container } = renderBar();
    await waitFor(() => {
      expect(container.querySelector('polygon')).not.toBeNull();
    });

    expect(container.querySelectorAll('polyline')).toHaveLength(0);

    fireEvent.focus(screen.getByTestId('steer-field'));

    await waitFor(() => {
      expect(container.querySelectorAll('polyline')).toHaveLength(2);
    });
  });

  it('paints in ink and canvas only, in either theme', async () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = renderBar(true, palette);
      await waitFor(() => {
        expect(container.querySelector('polygon')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
