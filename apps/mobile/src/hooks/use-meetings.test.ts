import type { MeetingListItem, NotesStatus } from '@nova/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMeetings, type MeetingsState } from './use-meetings';

/**
 * Freshness — the half of `useMeetings` a screen test can never see.
 *
 * A tab screen stays MOUNTED. Without the wiring under test here the one fetch at
 * mount is every byte of data the Meetings list ever gets: end a call, come back,
 * and the meeting you just had is missing until the app is restarted. And because
 * notes are written by a background job, the card's WRITING NOTES → NOTES READY
 * transition can only ever happen if something re-reads the list while the job runs.
 *
 * So two behaviours, both owned by the hook (screens stay dumb, RULES §10):
 *
 *   FOCUS — coming back to the screen re-reads the list SILENTLY: in place, and
 *   without touching `refreshing`, which drives the pull-to-refresh spinner. A
 *   focus refetch that yanked that spinner down would look like a bug.
 *
 *   POLL — while any meeting is still `queued`/`processing`, re-read every 5s, and
 *   stop the moment the work is done. A poll that outlives its reason is a battery
 *   drain and a bill: this is a network round trip on a phone.
 *
 * The fetch itself (timeout, zod rejection, signed-out derivation) is covered by the
 * shape it shares with `use-meeting-transcript.test.ts`; what is asserted here is
 * WHEN a request is made, and how many.
 */

const auth = vi.hoisted(() => ({
  value: {
    status: 'signed-in',
    session: { access_token: 'token-1' },
  } as { status: string; session?: { access_token: string } },
}));

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth.value }));

/**
 * A fake screen focus the test can drive. `useFocusEffect` is not stubbed away to a
 * no-op: its whole contract here is that the effect RE-RUNS on every focus and that
 * its cleanup runs on BLUR (not only on unmount), which is exactly what stops the
 * poll for a screen the user has navigated away from.
 */
const focus = vi.hoisted(() => {
  const listeners = new Set<(focused: boolean) => void>();
  return {
    listeners,
    value: true,
    set(next: boolean) {
      this.value = next;
      for (const listener of listeners) listener(next);
    },
  };
});

vi.mock('expo-router', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useFocusEffect: (effect: () => (() => void) | void) => {
      const [focused, setFocused] = useState(focus.value);
      useEffect(() => {
        const listener = (next: boolean): void => {
          setFocused(next);
        };
        focus.listeners.add(listener);
        return () => {
          focus.listeners.delete(listener);
        };
      }, []);
      useEffect(() => {
        if (!focused) return;
        return effect();
      }, [focused, effect]);
    },
  };
});

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  auth.value = { status: 'signed-in', session: { access_token: 'token-1' } };
  focus.listeners.clear();
  focus.value = true;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function item(status: NotesStatus, id: string): MeetingListItem {
  return {
    id,
    title: 'Northwind discovery',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    notes_status: status,
    tldr: null,
    conversation_type: null,
    action_item_count: 0,
    has_follow_up: false,
  };
}

/** One `GET /meetings` body, one meeting per status given. */
function body(...statuses: NotesStatus[]): unknown {
  return {
    meetings: statuses.map((status, i) =>
      item(status, `1111111${String(i)}-1111-4111-8111-111111111111`),
    ),
    month_count: statuses.length,
  };
}

/** The next answer the stubbed fetch will give (and every one after it). */
function respond(payload: unknown): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
  } as Response);
}

/** …and the two ways it can go wrong: the server answers badly, or not at all. */
function respondWithStatus(status: number): void {
  fetchMock.mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as Response);
}

function respondWithNothing(): void {
  fetchMock.mockRejectedValue(new TypeError('Network request failed'));
}

/** The meetings currently on screen — and proof the success branch survived. */
function meetingsOnScreen(state: MeetingsState): MeetingListItem[] {
  if (state.status !== 'success') {
    throw new Error(`expected a rendered list, got '${state.status}'`);
  }
  return state.data.meetings;
}

/**
 * Run the clock forward and let every promise the hook is waiting on settle.
 * `waitFor` is unusable here — @testing-library/dom 10 only knows how to detect
 * JEST's fake timers, so under vitest's it polls with a `setTimeout` that this test
 * has frozen, and hangs.
 */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useMeetings — coming back to the screen', () => {
  it('re-reads the list on focus, without pulling the spinner down', async () => {
    respond(body('completed'));
    const { result } = renderHook(() => useMeetings());
    await tick();

    expect(result.current.state.status).toBe('success');
    // Exactly one: the focus that arrives with the mount IS the mount fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond(body('completed', 'processing'));
    act(() => {
      focus.set(false);
    });
    act(() => {
      focus.set(true);
    });
    await tick();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (result.current.state.status !== 'success') throw new Error('unreachable');
    expect(result.current.state.data.meetings).toHaveLength(2);
  });

  it('never sets `refreshing` for a refetch the user did not ask for', async () => {
    respond(body('completed'));
    const { result } = renderHook(() => useMeetings());
    await tick();

    const seen: boolean[] = [];
    seen.push(result.current.refreshing);
    act(() => {
      focus.set(false);
    });
    act(() => {
      focus.set(true);
    });
    seen.push(result.current.refreshing);
    await tick();
    seen.push(result.current.refreshing);

    // The flag drives the pull-to-refresh spinner. A silent refetch that raised it
    // would drag that spinner into view on a screen the user merely returned to.
    expect(seen).toEqual([false, false, false]);
  });

  it('still turns the spinner for a pull-to-refresh', async () => {
    respond(body('completed'));
    const { result } = renderHook(() => useMeetings());
    await tick();

    act(() => {
      result.current.refresh();
    });
    expect(result.current.refreshing).toBe(true);

    await tick();
    expect(result.current.refreshing).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useMeetings — while the notes are being written', () => {
  it('polls every 5s, and stops as soon as the work lands', async () => {
    respond(body('completed', 'processing'));
    renderHook(() => useMeetings());
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The job finishes between this poll and the next.
    respond(body('completed', 'completed'));
    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Nothing left to watch: the interval must be gone, not merely quiet.
    await tick(5000);
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('polls for a queued meeting too, and not one millisecond early', async () => {
    respond(body('queued'));
    renderHook(() => useMeetings());
    await tick();

    // Split deliberately. Advancing the whole 5s in one go pins the interval from
    // ABOVE only: five 1s ticks inside one `act` batch into a single render and so
    // land as ONE fetch, which means a poll silently dropped to 1s would still read
    // as "called twice". The 5s cadence is a battery and a bill on a phone, so it
    // gets an assertion on each side of the boundary.
    await tick(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll when every meeting is settled', async () => {
    // `failed` and `none` are terminal for this screen — a poll waiting on them
    // would never stop.
    respond(body('completed', 'failed', 'none'));
    renderHook(() => useMeetings());
    await tick();

    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the screen loses focus', async () => {
    respond(body('processing'));
    renderHook(() => useMeetings());
    await tick();

    act(() => {
      focus.set(false);
    });
    await tick(60_000);

    // A background tab that keeps hitting the API is a bill nobody sees.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the session goes away', async () => {
    respond(body('processing'));
    const { rerender } = renderHook(() => useMeetings());
    await tick();

    auth.value = { status: 'signed-out' };
    rerender();
    await tick(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the screen goes away', async () => {
    respond(body('processing'));
    const { unmount } = renderHook(() => useMeetings());
    await tick();

    unmount();
    await tick(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The failure rule, and the whole reason `Request.silent` exists.
 *
 * An error card is an ANSWER — to a first load, or to a pull the user just made.
 * The two fetches added for freshness are not questions the user asked, so a Wi-Fi
 * handoff or a single 500 must not be allowed to take the archive off the screen
 * and replace it with COULD NOT LOAD YOUR CALLS. Worse, the poll is gated on the
 * success data: one bad tick that demoted the state would ALSO stop the polling,
 * stranding the card on WRITING NOTES until the user pulled the list themselves.
 */
describe('useMeetings — when a request the user never made fails', () => {
  it('keeps the list on screen, and keeps polling right through it', async () => {
    respond(body('processing'));
    const { result } = renderHook(() => useMeetings());
    await tick();

    respondWithStatus(500);
    await tick(5000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meetingsOnScreen(result.current.state)).toHaveLength(1);
    expect(meetingsOnScreen(result.current.state)[0]?.notes_status).toBe(
      'processing',
    );

    // The blip is over and the job has landed: the transition this feature exists
    // for still arrives, without the user touching anything.
    respond(body('completed'));
    await tick(5000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(meetingsOnScreen(result.current.state)[0]?.notes_status).toBe(
      'completed',
    );
  });

  it('keeps the list on screen when a focus refetch cannot reach the server', async () => {
    respond(body('completed'));
    const { result } = renderHook(() => useMeetings());
    await tick();

    respondWithNothing();
    act(() => {
      focus.set(false);
    });
    act(() => {
      focus.set(true);
    });
    await tick();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meetingsOnScreen(result.current.state)).toHaveLength(1);
  });

  it('still says so when the user asked — the pull, and the first load', async () => {
    respond(body('completed'));
    const { result } = renderHook(() => useMeetings());
    await tick();

    respondWithStatus(500);
    act(() => {
      result.current.refresh();
    });
    await tick();

    // A pull that answers with the same list it had would read as a frozen app.
    if (result.current.state.status !== 'error') throw new Error('unreachable');
    expect(result.current.state.message).toContain('500');

    respondWithStatus(503);
    const first = renderHook(() => useMeetings());
    await tick();

    // Nothing to preserve on a first load: the error card IS the screen.
    if (first.result.current.state.status !== 'error') {
      throw new Error('unreachable');
    }
    expect(first.result.current.state.message).toContain('503');
  });
});
