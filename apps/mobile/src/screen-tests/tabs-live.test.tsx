import { LIVE_PROTOCOL_VERSION } from '@nova/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Size, cobaltPalette, paperPalette } from '@/design/tokens';
import { THINKING_BEAT_MS, thinkingWordAt } from '@/features/stream/thinking';
import { expectDuotoneOnly } from '@/testing/duotone';
import { installLayoutStub } from '@/testing/layout-stub';
import { FakeLiveSocket, installFakeWebSocket } from '@/testing/live-socket-stub';

import LiveScreen from '../app/(app)/(tabs)/live';

/**
 * The cockpit (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4).
 *
 * Driven through the REAL `useLiveSession` over a fake socket rather than a mocked
 * hook: this screen IS the socket conversation, and the assertions worth making —
 * the steer goes up the existing wire, the chip lands on the answer it shaped, a
 * spent quota takes the whole screen — are all about what happens between a press
 * and a frame. A mocked hook would let every one of those wires be cut silently.
 */

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SUGGESTION_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    status: 'signed-in',
    session: { user: { id: 'user-1' }, access_token: 'token-1' },
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: MEETING_ID }, error: null }),
        }),
      }),
    }),
  },
}));

const router = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));

vi.mock('expo-router', () => ({ useRouter: () => router }));

vi.mock('react-native-safe-area-context', async () => {
  const { safeAreaStub } = await import('@/testing/safe-area-stub');
  return safeAreaStub();
});

vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * Reduced motion is ON for most of this suite, and that is a testability choice
 * rather than a coverage gap: with it on, `StreamingText` shows the whole
 * accumulated answer immediately instead of draining it at ~60 chars/sec, so an
 * assertion about the WORDS does not become an assertion about the clock. The
 * caret, the thinking bars and the handoff all still render — their timing is
 * pinned in `features/live-call/answer-card.test.tsx`, where it belongs.
 */
const reduced = vi.hoisted(() => ({ value: true }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
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
  reduced.value = true;
  router.push.mockReset();
  installFakeWebSocket();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Press START and drive the handshake to a live session. */
async function goLive(): Promise<FakeLiveSocket> {
  const before = FakeLiveSocket.instances.length;
  fireEvent.click(screen.getByTestId('start-session-key'));
  await waitFor(() => {
    expect(FakeLiveSocket.instances.length).toBeGreaterThan(before);
  });
  const socket = FakeLiveSocket.instances[before];
  act(() => {
    socket.open();
  });
  act(() => {
    socket.receive({
      v: LIVE_PROTOCOL_VERSION,
      type: 'session.ready',
      session_id: SESSION_ID,
    });
  });
  return socket;
}

/** Type a steer and press the key. */
function respond(steer: string): void {
  fireEvent.change(screen.getByTestId('steer-field'), {
    target: { value: steer },
  });
  fireEvent.click(screen.getByTestId('respond-key'));
}

function suggestionStart(): unknown {
  return {
    v: LIVE_PROTOCOL_VERSION,
    type: 'suggestion.start',
    suggestion_id: SUGGESTION_ID,
    kind: 'answer',
  };
}

function suggestionDelta(text: string): unknown {
  return {
    v: LIVE_PROTOCOL_VERSION,
    type: 'suggestion.delta',
    suggestion_id: SUGGESTION_ID,
    text,
  };
}

describe('LiveScreen — before the call', () => {
  it('offers the four modes and one key', () => {
    render(<LiveScreen />);

    expect(screen.getByTestId('mode-pill-general')).toBeInTheDocument();
    expect(screen.getByTestId('mode-pill-finance')).toBeInTheDocument();
    expect(screen.getByTestId('start-session-key')).toBeInTheDocument();
    // The bottom bar belongs to a call in progress; there is nothing to steer yet.
    expect(screen.queryByTestId('steer-field')).toBeNull();
  });

  it('names its key without the glyph', () => {
    // The ruling `app-tabs.tsx` sets out: `◉` is decoration, so the accessible name
    // is the words alone — the same shape `steer-bar.tsx`'s RESPOND key already has.
    render(<LiveScreen />);

    expect(screen.getByLabelText('Start session')).toBe(
      screen.getByTestId('start-session-key'),
    );
  });

  it('takes the picker away once the mode is locked, and names it on the rail', async () => {
    // The lock is structural: the server fixes the mode at `session.start`, so the
    // control that could change it is GONE for the length of the call and the rail
    // says which prompt is answering instead.
    render(<LiveScreen />);
    await goLive();

    expect(screen.queryByTestId('mode-pill-technical')).toBeNull();
    // The caps are a `textTransform`, so the rail's ACCESSIBLE text is the mode's
    // one spelling — not nine letters read out one at a time.
    expect(screen.getByTestId('hud-rail-mode')).toHaveTextContent('General');
    expect(
      getComputedStyle(screen.getByTestId('hud-rail-mode')).textTransform,
    ).toBe('uppercase');
  });
});

describe('LiveScreen — the cockpit', () => {
  it('flies the HUD clock and names the mode on the rail', async () => {
    render(<LiveScreen />);
    await goLive();

    expect(screen.getByText('◉ LIVE · 00:00')).toBeInTheDocument();
    expect(screen.getByTestId('hud-rail-mode')).toHaveTextContent('General');
  });

  it('will not respond to an empty steer', async () => {
    render(<LiveScreen />);
    await goLive();

    expect(screen.getByTestId('respond-key')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('sends the steer up the existing wire and chips it above the answer', async () => {
    render(<LiveScreen />);
    const socket = await goLive();

    respond('push on the timeline');

    // Everything `transcriptInputSchema` carries (`packages/shared/src/live.ts`):
    // the protocol version, the type, the text and the origin. There is no
    // `session_id` on this frame — the socket IS the session — so asserting one
    // would pin a field the server would reject.
    expect(socket.frame('transcript.input')).toMatchObject({
      v: LIVE_PROTOCOL_VERSION,
      type: 'transcript.input',
      text: 'push on the timeline',
      origin: 'utterance',
    });
    expect(screen.getByTestId('steer-chip')).toHaveTextContent(
      'push on the timeline',
    );
    // She is thinking before a single token has landed.
    expect(screen.getByTestId('answer-thinking')).toBeInTheDocument();
  });

  it('streams the answer into the card the steer belongs to', async () => {
    render(<LiveScreen />);
    const socket = await goLive();
    respond('push on the timeline');

    act(() => {
      socket.receive(suggestionStart());
    });
    act(() => {
      socket.receive(suggestionDelta('Ask them what changed.'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('stream-text')).toHaveTextContent(
        'Ask them what changed.',
      );
    });
    const card = screen.getByTestId('steer-chip').closest('[data-testid="answer-card"]');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('Ask them what changed.');
    // The caret is the only completion signal there is (spec §6).
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
  });

  it('does not restart her wait when the answer starts', async () => {
    // The card is drawn on the press and re-keyed nowhere: `suggestion.start` names
    // the answer, it does not introduce a new card. A key change here would remount
    // the thinking indicator and snap the word back to LISTENING mid-wait.
    render(<LiveScreen />);
    const socket = await goLive();

    // Real time for the handshake above only. The wait below runs on a clock this
    // test OWNS: under `shouldAdvanceTime` the cycle keeps turning between reading
    // `midWait` and the assertion after it, and the pass would depend on how fast
    // the machine got there.
    vi.useFakeTimers();
    try {
      respond('push on the timeline');

      act(() => {
        vi.advanceTimersByTime(THINKING_BEAT_MS * 2 + 40);
      });
      const midWait = screen.getByTestId('thinking-word').textContent;
      expect(midWait).not.toBe(thinkingWordAt(0));

      act(() => {
        socket.receive(suggestionStart());
      });

      expect(screen.getByTestId('thinking-word').textContent).toBe(midWait);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the record of what was said', async () => {
    render(<LiveScreen />);
    const socket = await goLive();

    act(() => {
      socket.receive({
        v: LIVE_PROTOCOL_VERSION,
        type: 'transcript.final',
        text: 'We are still comparing three vendors.',
        speaker: 'them',
        ts_ms: 1200,
        is_final: true,
      });
    });

    expect(
      screen.getByText('We are still comparing three vendors.'),
    ).toBeInTheDocument();
    expect(screen.getByText('THEM')).toBeInTheDocument();
  });

  it('keeps the capture pane transcript-only — the live-notes tab stays gone', async () => {
    // The pane was tabbed (TRANSCRIPT | LIVE NOTES) until the live-notes removal
    // (2026-08-04). This pins the replacement: a static transcript label where
    // the tab row sat, and no tab control that could quietly bring the preview
    // back without a decision.
    render(<LiveScreen />);
    await goLive();

    expect(screen.getByTestId('capture-pane')).toBeInTheDocument();
    expect(screen.getByTestId('capture-label-transcript')).toHaveTextContent(
      'TRANSCRIPT',
    );
    expect(screen.queryByTestId('capture-tab-notes')).toBeNull();
    expect(screen.queryByTestId('capture-tab-transcript')).toBeNull();
    expect(screen.queryByTestId('notes-unread-dot')).toBeNull();
  });
});

describe('LiveScreen — when it goes wrong', () => {
  it('takes the whole screen for a spent quota, with nothing to press', async () => {
    render(<LiveScreen />);
    const socket = await goLive();

    act(() => {
      socket.receive({
        v: LIVE_PROTOCOL_VERSION,
        type: 'error',
        code: 'quota_exceeded',
        message: 'stt quota exhausted for the current period',
      });
    });

    expect(screen.getByTestId('quota-card')).toBeInTheDocument();
    // No dead retry: nothing a press here re-runs the call the server refused.
    expect(screen.queryByTestId('respond-key')).toBeNull();
    expect(screen.queryByText(/retry|try again/i)).toBeNull();
    // But the screen is not a dead end either — it is a TAB, it never unmounts, and
    // the quota it is reporting will roll over.
    expect(screen.getByTestId('start-session-key')).toBeInTheDocument();
  });

  it('lets the next attempt clear the quota card', async () => {
    render(<LiveScreen />);
    const socket = await goLive();
    act(() => {
      socket.receive({
        v: LIVE_PROTOCOL_VERSION,
        type: 'error',
        code: 'quota_exceeded',
        message: 'stt quota exhausted for the current period',
      });
    });
    expect(screen.getByTestId('quota-card')).toBeInTheDocument();

    await goLive();

    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(screen.getByTestId('steer-field')).toBeInTheDocument();
  });

  it('says a lesser failure in one line and carries on', async () => {
    render(<LiveScreen />);
    const socket = await goLive();

    act(() => {
      socket.receive({
        v: LIVE_PROTOCOL_VERSION,
        type: 'error',
        code: 'internal',
        message: 'the conductor fell over',
      });
    });

    expect(screen.getByTestId('session-banner')).toHaveTextContent(
      'the conductor fell over',
    );
    expect(screen.getByTestId('steer-field')).toBeInTheDocument();
  });
});

describe('LiveScreen — after the call', () => {
  it('hands off to the notes and back to the archive', async () => {
    render(<LiveScreen />);
    await goLive();

    fireEvent.click(screen.getByTestId('end-session-key'));

    expect(screen.getByTestId('ended-summary')).toHaveTextContent('WRITING NOTES');
    // And the next call is one press away — the picker is back, and unlocked
    // (react-native-web omits `aria-disabled` entirely on an enabled control).
    expect(screen.getByTestId('mode-pill-technical')).not.toHaveAttribute(
      'aria-disabled',
    );

    fireEvent.click(screen.getByTestId('see-calls-key'));
    expect(router.push).toHaveBeenCalledWith('/');
  });

  it('does not call a failed attempt a finished call', async () => {
    // This screen is a TAB and never unmounts, so "a call ran" has to mean THIS
    // attempt — otherwise a start that dies before it connects inherits the summary
    // of the last call that worked.
    render(<LiveScreen />);
    await goLive();
    fireEvent.click(screen.getByTestId('end-session-key'));
    expect(screen.getByTestId('ended-summary')).toBeInTheDocument();

    const before = FakeLiveSocket.instances.length;
    fireEvent.click(screen.getByTestId('start-session-key'));
    await waitFor(() => {
      expect(FakeLiveSocket.instances.length).toBeGreaterThan(before);
    });
    act(() => {
      FakeLiveSocket.instances[before].onclose?.({
        code: 4401,
        reason: 'unauthorized',
      });
    });

    expect(screen.queryByTestId('ended-summary')).toBeNull();
    expect(screen.getByTestId('start-session-key')).toBeInTheDocument();
  });

  it('does not put ENDED over a start that never connected', async () => {
    // `closed` covers two different things and only `ran` tells them apart. A clean
    // close before `session.ready` leaves the screen on the idle panel — and
    // `◌ ENDED · 00:00` printed over "start a session" is the header announcing a
    // call that did not happen.
    render(<LiveScreen />);
    await goLive();
    fireEvent.click(screen.getByTestId('end-session-key'));
    // A real call ran, so this one keeps its ENDED and its final clock.
    expect(screen.getByTestId('live-hud')).toHaveTextContent('◌ ENDED');

    const before = FakeLiveSocket.instances.length;
    fireEvent.click(screen.getByTestId('start-session-key'));
    await waitFor(() => {
      expect(FakeLiveSocket.instances.length).toBeGreaterThan(before);
    });
    act(() => {
      FakeLiveSocket.instances[before].open();
    });
    act(() => {
      FakeLiveSocket.instances[before].onclose?.({ code: 1000, reason: '' });
    });

    expect(screen.getByTestId('live-hud')).toHaveTextContent('◌ STANDBY');
    expect(screen.queryByTestId('ended-summary')).toBeNull();
  });
});

/** The platform minimum, written out once so no assertion compares a token to itself. */
const TAP_FLOOR_PT = 44;

describe('LiveScreen — the targets', () => {
  it('gives every control the platform floor, as a real box', async () => {
    // A REAL minimum rather than `hitSlop`: react-native-web ignores hitSlop, and
    // Expo Web is this project's verification target — a slop-only target would look
    // right by eye and be unassertable here.
    expect(Size.tapTarget).toBeGreaterThanOrEqual(TAP_FLOOR_PT);

    render(<LiveScreen />);
    // Measured before the handshake: the picker is gone once the mode is locked.
    expect(
      Number.parseFloat(
        getComputedStyle(screen.getByTestId('mode-pill-general')).minHeight,
      ),
      'mode-pill-general is under the floor',
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PT);

    await goLive();

    for (const testID of ['end-session-key', 'respond-key']) {
      const control = screen.getByTestId(testID);
      const box = Number.parseFloat(getComputedStyle(control).minHeight);
      expect(box, `${testID} is under the 44pt floor`).toBeGreaterThanOrEqual(
        TAP_FLOOR_PT,
      );
    }
    // WIDTH is not measurable here and is not asserted rather than asserted
    // vacuously: jsdom has no layout engine, and `installLayoutStub` answers one
    // fixed `offsetWidth` for every node in the tree — so a width check would pass
    // for a control 4pt wide. These controls stretch to the width of their row;
    // that they do is a simulator check (spec §11, and this suite's own header).
  });
});

describe('LiveScreen — the duotone', () => {
  it('paints the live cockpit in ink and canvas only, in either theme', async () => {
    reduced.value = false;

    for (const palette of [cobaltPalette, paperPalette]) {
      scheme.value = palette === cobaltPalette ? 'dark' : 'light';
      const { container, unmount } = render(<LiveScreen />);
      const socket = await goLive();
      respond('push on the timeline');
      act(() => {
        socket.receive(suggestionStart());
      });
      await waitFor(() => {
        expect(container.querySelector('svg')).not.toBeNull();
      });

      expectDuotoneOnly(container, palette);
      unmount();
    }
  });
});
