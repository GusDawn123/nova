import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import type { MeetingTranscriptState } from '@/hooks/use-meeting-transcript';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { TranscriptPanel } from './transcript-panel';

/**
 * The Transcript view (spec §5): the record, in the order it was said.
 *
 * The state that matters most here is the one that looks like nothing: an EMPTY
 * transcript is a real answer — a call where nobody spoke — and must not be drawn
 * as a failure, while a failure must not be drawn as an empty call.
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

const TURNS = [
  { speaker: 'me', ts_ms: 0, content: 'Thanks for making the time.' },
  { speaker: 'them', ts_ms: 64_000, content: 'Of course — where should we start?' },
];

function renderPanel(
  state: MeetingTranscriptState,
  palette: Palette = cobaltPalette,
) {
  return render(
    <TranscriptPanel state={state} palette={palette} onRetry={onRetry} />,
  );
}

describe('TranscriptPanel', () => {
  it('tags each turn with who said it, and when', () => {
    renderPanel({ status: 'success', turns: TURNS });

    expect(screen.getByText('ME')).toBeInTheDocument();
    expect(screen.getByText('THEM')).toBeInTheDocument();
    expect(screen.getByText('01:04')).toBeInTheDocument();
    expect(screen.getByText('Thanks for making the time.')).toBeInTheDocument();
  });

  it('says a silent call was silent, without calling it an error', () => {
    renderPanel({ status: 'success', turns: [] });

    expect(screen.getByTestId('transcript-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-error')).toBeNull();
  });

  it('says what went wrong instead of showing a silent call', () => {
    renderPanel({ status: 'error', message: 'server returned HTTP 500' });

    expect(screen.getByTestId('transcript-error')).toBeInTheDocument();
    expect(screen.getByText('server returned HTTP 500')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-empty')).toBeNull();
  });

  it('offers a way out of a failed read rather than a dead end', () => {
    // The read is latched to the tab, so without this key one failure means the
    // transcript is unreachable for the life of the screen.
    renderPanel({ status: 'error', message: 'server returned HTTP 500' });

    fireEvent.click(screen.getByTestId('transcript-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('turns the ring while the record is being fetched', () => {
    renderPanel({ status: 'loading' });

    expect(screen.getByTestId('ring-orbit-rotor')).toBeInTheDocument();
  });

  it('paints in ink and canvas only, in either theme', async () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = renderPanel(
        { status: 'success', turns: TURNS },
        palette,
      );
      await waitFor(() => {
        expect(container.querySelector('div')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
