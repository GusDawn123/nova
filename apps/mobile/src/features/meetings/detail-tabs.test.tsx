import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { DetailTabs, type DetailTab } from './detail-tabs';

/**
 * The meeting detail's three tab pills.
 *
 * They are CONTROLS, so they are chamfered (spec §3) and the selected one is filled
 * — but the part that can silently break is the announcement. `accessibilityRole`
 * alone leaves the selected pill indistinguishable to a screen reader on the web
 * target, which is the failure this file exists to catch.
 */

const onSelect = vi.fn<(tab: DetailTab) => void>();

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  onSelect.mockReset();
});

function renderTabs(tab: DetailTab = 'notes', palette: Palette = cobaltPalette) {
  return render(<DetailTabs tab={tab} onSelect={onSelect} palette={palette} />);
}

describe('DetailTabs', () => {
  it('offers the three views, in the spec’s order', () => {
    renderTabs();

    expect(screen.getByText('NOTES')).toBeInTheDocument();
    expect(screen.getByText('TRANSCRIPT')).toBeInTheDocument();
    expect(screen.getByText('FOLLOW-UP')).toBeInTheDocument();
  });

  it('announces which view is open, and which are not', () => {
    renderTabs('transcript');

    expect(screen.getByTestId('detail-tab-transcript')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('detail-tab-notes')).toHaveAttribute(
      'aria-selected',
      'false',
    );
    // `tab` is only a valid role inside a tablist — without the container the
    // selected state announces against nothing.
    expect(screen.getByTestId('detail-tab-notes').closest('[role="tablist"]'))
      .not.toBeNull();
  });

  it('reports the tab that was pressed', () => {
    renderTabs('notes');

    fireEvent.click(screen.getByTestId('detail-tab-follow-up'));

    expect(onSelect).toHaveBeenCalledWith('follow-up');
  });

  it('paints in ink and canvas only, in either theme', async () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = renderTabs('notes', palette);
      await waitFor(() => {
        expect(container.querySelector('polygon')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
