import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingNotes } from '@nova/shared';

import { LiveNotesPanel } from './live-notes-panel';
import { emptyLiveNotes } from '@/features/notes/notes-update';
import { cobaltPalette } from '@/design/tokens';

/**
 * The in-call live-notes view (§5.1). Condensed on purpose: this is the preview a
 * user glances at mid-sentence, not the post-call document.
 */
vi.mock('expo-glass-effect', () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
}));

function notes(overrides: Partial<MeetingNotes> = {}): MeetingNotes {
  return {
    v: 2,
    title: 'Northwind discovery',
    tldr: 'Budget ceiling near $40k, procurement closes in two weeks.',
    overview: 'A discovery call about pricing.',
    conversationType: 'sales',
    decisions: [{ id: 'd1', text: 'Decide before Aug 5', quote: null }],
    actionItems: [
      {
        id: 'a1',
        text: 'Send the scope comparison',
        owner: 'you',
        deadline: null,
        deadlineRaw: 'Thursday',
        quote: null,
      },
    ],
    openQuestions: [{ id: 'q1', text: 'Who signs?' }],
    risks: [],
    typeInsights: { kind: 'sales', objections: [], buyingSignals: [] },
    source: 'live',
    ...overrides,
  } as MeetingNotes;
}

describe('LiveNotesPanel', () => {
  it('says nothing has landed yet before the first update', () => {
    render(<LiveNotesPanel state={emptyLiveNotes} palette={cobaltPalette} />);

    expect(screen.getByText(/notes start filling in/i)).toBeInTheDocument();
  });

  it('shows the tl;dr as soon as one fold has landed', () => {
    render(
      <LiveNotesPanel
        state={{ notes: notes(), rev: 0, hasUnseen: false }}
        palette={cobaltPalette}
      />,
    );

    expect(
      screen.getByText(/Budget ceiling near \$40k/),
    ).toBeInTheDocument();
  });

  it('lists action items with the spoken deadline, not an ISO date', () => {
    render(
      <LiveNotesPanel
        state={{ notes: notes(), rev: 1, hasUnseen: false }}
        palette={cobaltPalette}
      />,
    );

    expect(screen.getByText('Send the scope comparison')).toBeInTheDocument();
    expect(screen.getByText('Thursday')).toBeInTheDocument();
  });

  it('renders no checkboxes — a live item is provisional', () => {
    // Completion is keyed to the FINAL notes' item ids. Offering a checkbox here
    // would invite a tap that the next fold could silently move to another item.
    render(
      <LiveNotesPanel
        state={{ notes: notes(), rev: 1, hasUnseen: false }}
        palette={cobaltPalette}
      />,
    );

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('keeps showing the last fold rather than blanking when a call ends', () => {
    // rev stays set after the socket closes; the preview is still the truest
    // thing on screen until the post-call pipeline replaces it.
    render(
      <LiveNotesPanel
        state={{ notes: notes(), rev: 3, hasUnseen: true }}
        palette={cobaltPalette}
      />,
    );

    expect(screen.getByText(/Budget ceiling/)).toBeInTheDocument();
  });
});
