import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { AnswerCard, HANDOFF_MS } from './answer-card';

/**
 * One answer in the copilot history — the card the whole product is for.
 *
 * The thing it must never get wrong is the HANDOFF (spec §6): the bars fade over
 * ~240ms while the caret lands at the first character. Caret FIRST — if the
 * indicator unmounted on the same commit that the text arrived, there would be a
 * frame with neither a caret nor a word cycling, and the answer would look like it
 * restarted rather than started.
 *
 * The steer chip is the other half: it is the user's own words, and it belongs to
 * the answer it shaped, so it is drawn INSIDE this card rather than as a turn in the
 * transcript (spec §4 — it is never a fake transcript turn).
 */

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  reduced.value = false;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderCard(
  props: Partial<React.ComponentProps<typeof AnswerCard>> = {},
  palette: Palette = cobaltPalette,
) {
  return render(
    <AnswerCard
      palette={palette}
      steer={null}
      text=""
      streaming
      newest
      {...props}
    />,
  );
}

describe('AnswerCard — the wait', () => {
  it('shows her thinking while the answer has not started', () => {
    renderCard();

    expect(screen.getByTestId('answer-thinking')).toBeInTheDocument();
    expect(screen.queryByTestId('stream-text')).toBeNull();
  });

  it('announces the cycling word politely — it is the only thing saying what she is doing', () => {
    renderCard();

    expect(screen.getByTestId('answer-thinking')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('lands the caret BEFORE the bars leave', () => {
    const { rerender } = renderCard();

    rerender(
      <AnswerCard palette={cobaltPalette} steer={null} text="Ask them" streaming newest />,
    );

    // Same commit: the caret is on screen and the indicator has not gone yet.
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
    expect(screen.getByTestId('answer-thinking')).toBeInTheDocument();
  });

  it('drops the bars once the fade has run', async () => {
    const { rerender } = renderCard();

    rerender(
      <AnswerCard palette={cobaltPalette} steer={null} text="Ask them" streaming newest />,
    );
    act(() => {
      vi.advanceTimersByTime(HANDOFF_MS + 20);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('answer-thinking')).toBeNull();
    });
  });

  it('cuts straight to the words when motion is reduced', () => {
    reduced.value = true;
    const { rerender } = renderCard();

    rerender(
      <AnswerCard palette={cobaltPalette} steer={null} text="Ask them" streaming newest />,
    );

    expect(screen.queryByTestId('answer-thinking')).toBeNull();
  });

  it('never shows the wait on an answer that is already written', () => {
    renderCard({ text: 'Ask them what changed.', streaming: false });

    expect(screen.queryByTestId('answer-thinking')).toBeNull();
    expect(screen.getByTestId('stream-text')).toBeInTheDocument();
  });
});

describe('AnswerCard — the words', () => {
  it('labels the card as the thing to say', () => {
    renderCard({ text: 'Ask them what changed.', streaming: false });

    expect(screen.getByText('◆ NOVA · SAY THIS')).toBeInTheDocument();
  });

  it('draws the steer as the user’s own chip above the answer', () => {
    renderCard({ steer: 'push on the timeline', text: 'Ask them', streaming: false });

    const chip = screen.getByTestId('steer-chip');
    expect(chip).toHaveTextContent('push on the timeline');
    expect(normaliseColor(getComputedStyle(chip).backgroundColor)).toBe(
      normaliseColor(cobaltPalette.ink),
    );
  });

  it('draws no chip on an answer nobody steered', () => {
    renderCard({ text: 'Ask them', streaming: false });

    expect(screen.queryByTestId('steer-chip')).toBeNull();
  });

  it('gives the newest answer the full-ink border and the older ones a hairline', () => {
    const first = renderCard({ text: 'a', streaming: false });
    const newest = within(first.container).getByTestId('answer-card');
    expect(normaliseColor(getComputedStyle(newest).borderTopColor)).toBe(
      normaliseColor(cobaltPalette.ink),
    );
    expect(normaliseColor(getComputedStyle(newest).backgroundColor)).toBe(
      normaliseColor(cobaltPalette.inkFill),
    );
    first.unmount();

    const second = renderCard({ text: 'a', streaming: false, newest: false });
    const older = within(second.container).getByTestId('answer-card');
    expect(normaliseColor(getComputedStyle(older).borderTopColor)).toBe(
      normaliseColor(cobaltPalette.inkHairline),
    );
  });
});

describe('AnswerCard — the duotone', () => {
  it('paints in ink and canvas only, in either theme', async () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = renderCard(
        { steer: 'push on the timeline' },
        palette,
      );
      await waitFor(() => {
        expect(container.querySelector('svg')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
