import type { FollowUpStored } from '@nova/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { mapFollowUpFailure } from './follow-up';
import { FollowUpPanel } from './follow-up-panel';

/**
 * The Follow-up view (spec §5): the draft, or the reason there is not one.
 *
 * `canRetry` is the whole point of the failure map, and it is a claim about the
 * WORLD, not about the copy: a 404 means the meeting is gone, and a button offering
 * to try again on a call that no longer exists is a button that cannot work.
 */

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => false,
}));

const onRetry = vi.fn<() => void>();

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  onRetry.mockReset();
});

const DRAFT: FollowUpStored = {
  tone: 'professional',
  subject: 'Northwind — next steps',
  body: 'Thanks again for the time today. Sending the revised quote by Thursday.',
  generated_at: '2026-08-01T14:05:00.000Z',
};

function renderPanel(
  props: Partial<React.ComponentProps<typeof FollowUpPanel>> = {},
  palette: Palette = cobaltPalette,
) {
  return render(
    <FollowUpPanel
      draft={null}
      failure={null}
      onRetry={onRetry}
      palette={palette}
      {...props}
    />,
  );
}

describe('FollowUpPanel', () => {
  it('shows the draft it has, subject and body', () => {
    renderPanel({ draft: DRAFT });

    expect(screen.getByText('Northwind — next steps')).toBeInTheDocument();
    expect(screen.getByText(DRAFT.body)).toBeInTheDocument();
  });

  it('offers no retry for a call that is gone', () => {
    const failure = mapFollowUpFailure(404, undefined);
    renderPanel({ failure });

    expect(failure.kind).toBe('gone');
    expect(screen.getByTestId('follow-up-state')).toBeInTheDocument();
    expect(screen.queryByTestId('follow-up-retry')).toBeNull();
  });

  it('offers no retry for notes that simply have not landed', () => {
    renderPanel({ failure: mapFollowUpFailure(409, 'notes_not_ready') });

    expect(screen.queryByTestId('follow-up-retry')).toBeNull();
  });

  it('offers the retry when trying again could actually work', () => {
    renderPanel({ failure: mapFollowUpFailure(503, undefined) });

    fireEvent.click(screen.getByTestId('follow-up-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is quiet when there is simply no draft yet', () => {
    renderPanel();

    expect(screen.getByTestId('follow-up-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('follow-up-retry')).toBeNull();
  });

  it('paints in ink and canvas only, in either theme', async () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = renderPanel(
        { failure: mapFollowUpFailure(503, undefined) },
        palette,
      );
      await waitFor(() => {
        expect(container.querySelector('polygon')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
