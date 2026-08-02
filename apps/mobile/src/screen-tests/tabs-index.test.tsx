import type { MeetingListItem } from '@nova/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { View } from 'react-native';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { tabBarClearance } from '@/design/tab-bar-metrics';
import { cobaltPalette, paperPalette } from '@/design/tokens';
import type { MascotStageProps } from '@/features/mascot/mascot-stage';
import type { MeetingsState } from '@/hooks/use-meetings';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';

import MeetingsScreen from '../app/(app)/(tabs)/index';

/**
 * Meetings — the archive (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * The list is four screens in one, and the three that are not "here are your calls"
 * are the ones a redesign drops: the empty state has to be the mascot moment with a
 * way to start a call, the error state has to offer the retry it always did, and the
 * signed-out state must NOT — nothing this screen can re-run mints a session, and a
 * retry that cannot work is worse than no button at all.
 *
 * `useMeetings` is mocked because it is not the subject: its fetch, timeout and
 * signed-out derivation have their own coverage. What is asserted here is that each
 * of its four branches reaches the screen the spec draws.
 */

const meetings = vi.hoisted(() => ({
  state: { status: 'loading' } as MeetingsState,
  refresh: vi.fn<() => void>(),
  refreshing: false,
}));

vi.mock('@/hooks/use-meetings', () => ({
  useMeetings: () => meetings,
}));

const router = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));

/**
 * `useFocusEffect` is run through `useEffect` rather than stubbed away: the screen
 * re-reads the clock on focus so an app left open across midnight does not keep
 * calling yesterday "today", and a no-op mock would let that wiring be deleted
 * without a single test noticing.
 */
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useRouter: () => router,
    useFocusEffect: (callback: () => void) => {
      useEffect(callback, [callback]);
    },
  };
});

vi.mock('react-native-safe-area-context', async () => {
  const { safeAreaStub } = await import('@/testing/safe-area-stub');
  return safeAreaStub();
});

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * Reduced motion is driven from here: jsdom has no `window.matchMedia`, and
 * react-native-web's `AccessibilityInfo` answers "yes, reduce" when it cannot ask —
 * so every loop in this suite would be absent for the wrong reason.
 */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

/** She has her own suite; the duotone case below renders the real one. */
const realMascot = vi.hoisted(() => ({ value: false }));

vi.mock('@/features/mascot/mascot-stage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/mascot/mascot-stage')>();
  return {
    MascotStage: (props: MascotStageProps) =>
      realMascot.value ? (
        <actual.MascotStage {...props} />
      ) : (
        <View testID="mascot-stage" style={{ width: props.size, height: props.size }} />
      ),
  };
});

vi.mock('expo-image', () => ({
  Image: ({ style, testID }: { style?: unknown; testID?: string }) => (
    <View testID={testID} style={style as React.ComponentProps<typeof View>['style']} />
  ),
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
  reduced.value = false;
  realMascot.value = false;
  meetings.state = { status: 'loading' };
  meetings.refreshing = false;
  meetings.refresh.mockReset();
  router.push.mockReset();
});

const HOUR_MS = 60 * 60 * 1000;

function item(overrides: Partial<MeetingListItem> = {}): MeetingListItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Northwind discovery',
    started_at: new Date(Date.now() - HOUR_MS).toISOString(),
    ended_at: new Date().toISOString(),
    notes_status: 'completed',
    tldr: 'Three vendors, $40k left.',
    conversation_type: 'sales',
    action_item_count: 3,
    has_follow_up: true,
    ...overrides,
  };
}

function succeed(meetingList: MeetingListItem[], monthCount = meetingList.length): void {
  meetings.state = {
    status: 'success',
    data: { meetings: meetingList, month_count: monthCount },
  };
}

describe('MeetingsScreen — the archive', () => {
  it('heads the list with the wordmark and the month’s count', () => {
    succeed([item()], 18);

    render(<MeetingsScreen />);

    expect(screen.getByText('MEETINGS')).toBeInTheDocument();
    expect(screen.getByText('18 this month')).toBeInTheDocument();
  });

  it('groups by recency, against the clock it reads at focus', () => {
    const old = new Date(Date.now() - 40 * 24 * HOUR_MS).toISOString();
    succeed([
      item(),
      item({ id: '22222222-2222-4222-8222-222222222222', started_at: old, ended_at: old }),
    ]);

    render(<MeetingsScreen />);

    expect(screen.getByText('— Today —')).toBeInTheDocument();
    expect(screen.getByText('— Earlier —')).toBeInTheDocument();
    expect(screen.queryByText('— This week —')).toBeNull();
  });

  it('leaves the floating tab bar room to float over', () => {
    // The bar is absolutely positioned, so it reserves no layout space: the last
    // card is only reachable because this padding is here (`tab-bar-metrics.ts`).
    succeed([item()]);

    render(<MeetingsScreen />);
    const content = screen.getByTestId('meetings-scroll').querySelector('div');
    if (content === null) throw new Error('expected a content container');

    expect(getComputedStyle(content).paddingBottom).toBe(`${tabBarClearance(0)}px`);
  });

  it('no longer carries the account key — the tab bar owns that route now', () => {
    // The key was a bridge, parked in this header only because Account had no tab.
    // It has one (`◌ ACCOUNT`), and two doors to the same room is one too many.
    succeed([item()]);

    render(<MeetingsScreen />);

    expect(screen.queryByTestId('account-button')).toBeNull();
  });
});

describe('MeetingsScreen — nothing yet', () => {
  it('is her, the invitation, and one key', () => {
    succeed([], 0);

    render(<MeetingsScreen />);

    expect(screen.getByTestId('mascot-stage')).toBeInTheDocument();
    expect(screen.getByText('NO CALLS YET')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your first call becomes your first memory. I'll keep the notes.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('start-session-key'));
    expect(router.push).toHaveBeenCalledWith('/live');
  });

  it('names its key without the glyph', () => {
    // The ruling `app-tabs.tsx` sets out: `◉` is decoration, so the accessible name
    // is the words alone. This is the primary call to action on the first screen a
    // new account ever sees, which makes it the worst one to leave reading as
    // "fisheye start a session" — or, on the readers that skip the glyph entirely,
    // as an unlabelled button.
    succeed([], 0);

    render(<MeetingsScreen />);

    expect(screen.getByLabelText('Start a session')).toBe(
      screen.getByTestId('start-session-key'),
    );
  });
});

describe('MeetingsScreen — waiting, failing, signed out', () => {
  it('shows the skeletons and nothing else while the list loads', () => {
    // The skeletons' own behaviour — the bars, and what reduced motion does to the
    // sheen — belongs to `features/meetings/loading-list.test.tsx`. What is asserted
    // here is only that the loading BRANCH reaches them, and reaches nothing else.
    meetings.state = { status: 'loading' };

    render(<MeetingsScreen />);

    expect(screen.getAllByTestId(/^skeleton-card-/)).toHaveLength(3);
    expect(screen.queryByTestId('mascot-stage')).toBeNull();
    expect(screen.queryByTestId('error-card')).toBeNull();
  });

  it('says what went wrong and offers the retry it always had', () => {
    meetings.state = { status: 'error', message: 'server returned HTTP 500' };

    render(<MeetingsScreen />);
    expect(screen.getByText('server returned HTTP 500')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('retry-button'));
    expect(meetings.refresh).toHaveBeenCalledTimes(1);
  });

  it('offers NO retry when there is no session to retry with', () => {
    meetings.state = { status: 'signed-out' };

    render(<MeetingsScreen />);

    expect(screen.getByTestId('signed-out-card')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-button')).toBeNull();
    expect(screen.queryByText('RETRY')).toBeNull();
  });
});

describe('MeetingsScreen — the duotone', () => {
  it('paints the empty state in ink and canvas only, in either theme', async () => {
    // Her included — glow gradient, scanlines and tear layers all paint colour.
    realMascot.value = true;
    succeed([], 0);

    const cobalt = render(<MeetingsScreen />);
    await waitFor(() => {
      expect(cobalt.container.querySelector('svg')).toBeTruthy();
    });
    expectDuotoneOnly(cobalt.container, cobaltPalette);
    cobalt.unmount();

    scheme.value = 'light';
    const paper = render(<MeetingsScreen />);
    await waitFor(() => {
      expect(paper.container.querySelector('svg')).toBeTruthy();
    });
    expectDuotoneOnly(paper.container, paperPalette);
  });

  it('paints a loaded list in ink and canvas only', async () => {
    succeed([item({ notes_status: 'processing' }), item({ id: '33333333-3333-4333-8333-333333333333', notes_status: 'failed' })]);

    const { container } = render(<MeetingsScreen />);
    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });

    expectDuotoneOnly(container, cobaltPalette);
  });
});
