import type { MeetingNotes, NotesReadResponse } from '@nova/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette, paperPalette } from '@/design/tokens';
import type { MeetingNotesState } from '@/hooks/use-meeting-notes';
import type { MeetingTranscriptState } from '@/hooks/use-meeting-transcript';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import MeetingDetailScreen from './[id]';

/**
 * The meeting detail (spec §5).
 *
 * The screen is three views over one meeting, and what it must never do is let a
 * broken notes pipeline take the call with it. So the states are tested as a PAIR
 * every time: whatever the notes are doing — folding, failed, never written — the
 * transcript tab has to stay open, because the transcript is the thing that
 * actually happened.
 *
 * Both hooks are mocked. Their fetches, their idle contracts and the optimistic
 * checkbox write all have their own suites; what is asserted here is that each
 * branch of their state reaches the screen the spec draws, and that the checkbox
 * still reports to the hook that owns the write.
 */

const MEETING_ID = '11111111-1111-4111-8111-111111111111';

const notesHook = vi.hoisted(() => ({
  state: { status: 'loading' } as MeetingNotesState,
  completedIds: new Set<string>(),
  toggleItem: vi.fn<(itemId: string, completed: boolean) => void>(),
  refresh: vi.fn<() => void>(),
}));

vi.mock('@/hooks/use-meeting-notes', () => ({
  useMeetingNotes: () => notesHook,
}));

const transcriptHook = vi.hoisted(() => ({
  state: { status: 'idle' } as MeetingTranscriptState,
  /** What the screen asked for — the laziness claim is the screen's to keep. */
  enabled: false,
}));

vi.mock('@/hooks/use-meeting-transcript', () => ({
  useMeetingTranscript: (_id: string | null, enabled: boolean) => {
    transcriptHook.enabled = enabled;
    return { state: transcriptHook.state };
  },
}));

const router = vi.hoisted(() => ({ back: vi.fn<() => void>() }));
const params = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useLocalSearchParams: () => params.value,
}));

vi.mock('react-native-safe-area-context', async () => {
  const { safeAreaStub } = await import('@/testing/safe-area-stub');
  return safeAreaStub();
});

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * jsdom has no `matchMedia`, and react-native-web's `AccessibilityInfo` answers
 * "yes, reduce" when it cannot ask — so the ring would be still in every test here
 * for the wrong reason.
 */
vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => false,
}));

/** No provider is mounted, so `usePalette` reads the OS — flipped per test. */
const scheme = vi.hoisted(() => ({ value: 'dark' as 'dark' | 'light' }));

vi.mock('react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-native')>()),
  useColorScheme: () => scheme.value,
}));

beforeAll(() => {
  installLayoutStub();
});

beforeEach(() => {
  scheme.value = 'dark';
  params.value = { id: MEETING_ID };
  notesHook.state = { status: 'loading' };
  notesHook.completedIds = new Set();
  notesHook.toggleItem.mockReset();
  notesHook.refresh.mockReset();
  transcriptHook.state = { status: 'idle' };
  transcriptHook.enabled = false;
});

function notes(overrides: Partial<MeetingNotes> = {}): MeetingNotes {
  return {
    version: 2,
    conversationType: 'sales',
    title: 'Northwind discovery',
    tldr: 'Budget ceiling near $40k.',
    overview: 'A discovery call about pricing.',
    decisions: [],
    actionItems: [
      {
        id: 'a_1',
        text: 'Send the revised quote.',
        owner: 'Dana',
        deadline: null,
        deadlineRaw: 'Thursday',
        quote: null,
      },
    ],
    openQuestions: [],
    risks: [],
    typeInsights: { kind: 'sales', objections: [], buyingSignals: [] },
    source: 'generated',
    ...overrides,
  };
}

function succeed(overrides: Partial<NotesReadResponse> = {}): void {
  notesHook.state = {
    status: 'success',
    data: {
      notes_status: 'completed',
      notes: notes(),
      follow_up: null,
      notes_generated_at: new Date().toISOString(),
      live_notes: null,
      live_notes_rev: null,
      completed_item_ids: [],
      ...overrides,
    },
  };
}

const TURNS = [{ speaker: 'them', ts_ms: 0, content: 'Where should we start?' }];

describe('MeetingDetailScreen — the frame', () => {
  it('names the call, and the way back to the list', () => {
    succeed();

    render(<MeetingDetailScreen />);
    expect(screen.getByText('Northwind discovery')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('back-button'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('dates the call in mono, from what it actually knows', () => {
    succeed();

    render(<MeetingDetailScreen />);

    // The read model carries no call clock — only when the notes were written —
    // so the line says which of the two it is rather than implying the other.
    expect(screen.getByTestId('detail-meta')).toHaveTextContent('SALES');
    expect(screen.getByTestId('detail-meta')).toHaveTextContent('TODAY');
  });

  it('opens on the notes, and switches to another view when asked', () => {
    succeed();
    transcriptHook.state = { status: 'success', turns: TURNS };

    render(<MeetingDetailScreen />);
    expect(screen.getByTestId('notes-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('detail-tab-transcript'));

    expect(screen.getByText('Where should we start?')).toBeInTheDocument();
    expect(screen.queryByTestId('notes-panel')).toBeNull();
    expect(screen.getByTestId('detail-tab-transcript')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('detail-tab-notes')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('asks for the transcript only once the tab is open', () => {
    succeed();

    render(<MeetingDetailScreen />);
    expect(transcriptHook.enabled).toBe(false);

    fireEvent.click(screen.getByTestId('detail-tab-transcript'));
    expect(transcriptHook.enabled).toBe(true);
  });

  it('is only the apology when the link does not name a meeting', () => {
    params.value = { id: ['two', 'ids'] };

    render(<MeetingDetailScreen />);

    expect(screen.getByTestId('detail-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-tab-notes')).toBeNull();
  });
});

describe('MeetingDetailScreen — the checkbox still writes', () => {
  it('reports a tick to the hook that owns the write', () => {
    succeed();

    render(<MeetingDetailScreen />);
    fireEvent.click(screen.getByTestId('action-item-a_1'));

    expect(notesHook.toggleItem).toHaveBeenCalledWith('a_1', true);
  });

  it('draws the optimistic state the hook is holding', () => {
    succeed();
    notesHook.completedIds = new Set(['a_1']);

    render(<MeetingDetailScreen />);

    expect(screen.getByTestId('action-item-a_1')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('MeetingDetailScreen — while the notes are still folding', () => {
  it('turns the ring and says how long, without blocking the transcript', () => {
    succeed({ notes_status: 'processing', notes: null, notes_generated_at: null });
    transcriptHook.state = { status: 'success', turns: TURNS };

    render(<MeetingDetailScreen />);

    expect(screen.getByTestId('notes-processing')).toBeInTheDocument();
    expect(screen.getByTestId('ring-orbit-rotor')).toBeInTheDocument();
    expect(
      screen.getByText("She's re-reading the call. A minute, maybe two."),
    ).toBeInTheDocument();

    // The transcript is what actually happened; a pipeline still chewing on it
    // must not take it away.
    fireEvent.click(screen.getByTestId('detail-tab-transcript'));
    expect(screen.getByText('Where should we start?')).toBeInTheDocument();
  });

  it('shows the running preview when there is one, and says it is one', () => {
    succeed({
      notes_status: 'processing',
      notes: null,
      live_notes: notes({ tldr: 'Still writing this down.' }),
      live_notes_rev: 3,
      notes_generated_at: null,
    });

    render(<MeetingDetailScreen />);

    expect(screen.getByText('Still writing this down.')).toBeInTheDocument();
    expect(screen.getByTestId('notes-preview-note')).toBeInTheDocument();
  });
});

describe('MeetingDetailScreen — when the notes never came', () => {
  it('admits it, offers the one thing that can help, and keeps the record', () => {
    succeed({ notes_status: 'failed', notes: null, notes_generated_at: null });
    transcriptHook.state = { status: 'success', turns: TURNS };

    render(<MeetingDetailScreen />);

    expect(
      screen.getByText("The notes didn't make it through"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('ring-orbit-rotor')).toBeNull();

    fireEvent.click(screen.getByTestId('notes-retry'));
    expect(notesHook.refresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('detail-tab-transcript'));
    expect(screen.getByText('Where should we start?')).toBeInTheDocument();
  });

  it('is quiet about an old call that never had notes', () => {
    succeed({ notes_status: 'none', notes: null, notes_generated_at: null });

    render(<MeetingDetailScreen />);

    expect(screen.getByTestId('notes-empty')).toBeInTheDocument();
    // No ceremony: nothing failed, nothing is coming, nothing to press.
    expect(screen.queryByTestId('notes-retry')).toBeNull();
    expect(screen.queryByTestId('ring-orbit-rotor')).toBeNull();
  });

  it('says what the read itself failed with, and offers to try again', () => {
    notesHook.state = { status: 'error', message: 'server returned HTTP 500' };

    render(<MeetingDetailScreen />);

    expect(screen.getByText('server returned HTTP 500')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('notes-retry'));
    expect(notesHook.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('MeetingDetailScreen — the follow-up', () => {
  it('shows the draft the call produced', () => {
    succeed({
      follow_up: {
        tone: 'professional',
        subject: 'Northwind — next steps',
        body: 'Sending the revised quote by Thursday.',
        generated_at: '2026-08-01T14:05:00.000Z',
      },
    });

    render(<MeetingDetailScreen />);
    fireEvent.click(screen.getByTestId('detail-tab-follow-up'));

    expect(screen.getByText('Northwind — next steps')).toBeInTheDocument();
  });

  it('waits rather than failing while the notes it needs are still folding', () => {
    succeed({ notes_status: 'processing', notes: null, notes_generated_at: null });

    render(<MeetingDetailScreen />);
    fireEvent.click(screen.getByTestId('detail-tab-follow-up'));

    expect(screen.getByTestId('follow-up-state')).toBeInTheDocument();
    expect(screen.queryByTestId('follow-up-retry')).toBeNull();
  });
});

describe('MeetingDetailScreen — the duotone', () => {
  it('paints notes, transcript and follow-up in ink and canvas only', async () => {
    succeed({ notes: notes({ decisions: [{ id: 'd_1', text: 'Ship in August.', quote: 'August it is.' }] }) });
    transcriptHook.state = { status: 'success', turns: TURNS };
    notesHook.completedIds = new Set(['a_1']);

    for (const palette of [cobaltPalette, paperPalette]) {
      scheme.value = palette === cobaltPalette ? 'dark' : 'light';
      const { container, unmount } = render(<MeetingDetailScreen />);
      await waitFor(() => {
        expect(container.querySelector('polygon')).not.toBeNull();
      });
      expectDuotoneOnly(container, palette);

      fireEvent.click(screen.getByTestId('detail-tab-transcript'));
      expectDuotoneOnly(container, palette);
      unmount();
    }
  });

  it('paints a failure without reaching for a colour', async () => {
    succeed({ notes_status: 'failed', notes: null, notes_generated_at: null });

    const { container } = render(<MeetingDetailScreen />);
    await waitFor(() => {
      expect(container.querySelector('polygon')).not.toBeNull();
    });

    expectDuotoneOnly(container, cobaltPalette);
  });
});
