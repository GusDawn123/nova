import type { MeetingNotes } from '@nova/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette, type Palette } from '@/design/tokens';
import { expectDuotoneOnly, normaliseColor } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import { NotesPanel } from './notes-panel';

/**
 * The Notes view (spec §5).
 *
 * Two claims are worth a test and the rest is layout. The first is that a section
 * with nothing in it is not drawn AT ALL — an empty "Decisions" heading is a call
 * that looks like it decided nothing, which is not the same as a call whose
 * decisions were not extracted. The second is the checkbox: it is the one thing on
 * this screen that WRITES, and the write is the screen's, not the panel's.
 */

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => false,
}));

const onToggleItem = vi.fn<(itemId: string, completed: boolean) => void>();

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  onToggleItem.mockReset();
});

function notes(overrides: Partial<MeetingNotes> = {}): MeetingNotes {
  return {
    version: 2,
    conversationType: 'sales',
    title: 'Northwind discovery',
    tldr: 'Budget ceiling near $40k, three vendors still in.',
    overview: 'A discovery call about pricing.',
    decisions: [
      { id: 'd_1', text: 'Ship the pilot in August.', quote: 'August it is.' },
    ],
    actionItems: [
      {
        id: 'a_1',
        text: 'Send the revised quote.',
        owner: 'Dana',
        deadline: null,
        deadlineRaw: 'Thursday',
        quote: null,
      },
      {
        id: 'a_2',
        text: 'Book the security review.',
        owner: null,
        deadline: null,
        deadlineRaw: null,
        quote: null,
      },
    ],
    openQuestions: [{ id: 'q_1', text: 'Who signs the DPA?' }],
    risks: [{ id: 'r_1', text: 'Their legal team is a month out.' }],
    typeInsights: { kind: 'sales', objections: [], buyingSignals: [] },
    source: 'generated',
    ...overrides,
  };
}

function renderPanel(
  data: MeetingNotes = notes(),
  completedIds: ReadonlySet<string> = new Set(),
  palette: Palette = cobaltPalette,
) {
  return render(
    <NotesPanel
      notes={data}
      palette={palette}
      completedIds={completedIds}
      onToggleItem={onToggleItem}
    />,
  );
}

describe('NotesPanel — what it draws', () => {
  it('leads with the tl;dr and lists what the call produced', () => {
    renderPanel();

    expect(
      screen.getByText('Budget ceiling near $40k, three vendors still in.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Send the revised quote.')).toBeInTheDocument();
    expect(screen.getByText('Who signs the DPA?')).toBeInTheDocument();
  });

  it('omits a section it has nothing for, heading and all', () => {
    renderPanel(notes({ decisions: [], openQuestions: [], risks: [] }));

    expect(screen.queryByText('DECISIONS')).toBeNull();
    expect(screen.queryByText('OPEN')).toBeNull();
    expect(screen.queryByText('RISKS')).toBeNull();
    // The two that still have content are untouched.
    expect(screen.getByText('ACTION ITEMS')).toBeInTheDocument();
  });

  it('keeps the spoken deadline phrase rather than a date nobody said', () => {
    renderPanel();

    expect(screen.getByText('Thursday')).toBeInTheDocument();
  });
});

describe('NotesPanel — the checkbox', () => {
  it('asks the screen to check an item, and to uncheck a checked one', () => {
    const { unmount } = renderPanel();
    fireEvent.click(screen.getByTestId('action-item-a_1'));
    expect(onToggleItem).toHaveBeenCalledWith('a_1', true);
    unmount();

    renderPanel(notes(), new Set(['a_1']));
    fireEvent.click(screen.getByTestId('action-item-a_1'));
    expect(onToggleItem).toHaveBeenCalledWith('a_1', false);
  });

  it('announces its own state rather than leaving it to the tick', () => {
    renderPanel(notes(), new Set(['a_1']));

    const row = screen.getByTestId('action-item-a_1');
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('action-item-a_2')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('strikes a done row and drops it to secondary ink', () => {
    renderPanel(notes(), new Set(['a_1']));

    const done = screen.getByText('Send the revised quote.');
    const style = getComputedStyle(done);
    expect(style.textDecorationLine || style.textDecoration).toContain(
      'line-through',
    );
    expect(normaliseColor(style.color)).toBe(
      normaliseColor(cobaltPalette.inkSoft),
    );
  });
});

describe('NotesPanel — the duotone', () => {
  it('paints in ink and canvas only, in either theme', async () => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const { container, unmount } = renderPanel(
        notes(),
        new Set(['a_1']),
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
