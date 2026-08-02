import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMeetingTranscript } from './use-meeting-transcript';

/**
 * The transcript read behind the detail screen's second tab.
 *
 * Two things here can be wrong in a way a screen test would never catch. The first
 * is LAZINESS: a transcript is the longest thing this API returns and most opens of
 * a meeting never look at it, so the fetch has to wait for the tab rather than ride
 * along with the notes read. The second is the idle contract it shares with
 * `useMeetingNotes` — no token or no meeting id means no request, not a request with
 * `null` interpolated into its URL.
 */

const MEETING_ID = '11111111-1111-4111-8111-111111111111';

const auth = vi.hoisted(() => ({
  value: {
    status: 'signed-in',
    session: { access_token: 'token-1' },
  } as { status: string; session?: { access_token: string } },
}));

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth.value }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  auth.value = { status: 'signed-in', session: { access_token: 'token-1' } };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Here rather than at the end of the one test that installs them: a failed
  // assertion skips the rest of its test body, and fake timers left running leak
  // into every test after it in this file.
  vi.useRealTimers();
});

function respond(body: unknown, ok = true, status = 200): void {
  fetchMock.mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const TURNS = [
  { speaker: 'me', ts_ms: 0, content: 'Thanks for making the time.' },
  { speaker: 'them', ts_ms: 4200, content: 'Of course.' },
];

describe('useMeetingTranscript', () => {
  it('asks for nothing until the tab is opened', () => {
    respond({ turns: TURNS });

    const { result } = renderHook(() =>
      useMeetingTranscript(MEETING_ID, false),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('idle');
  });

  it('loads the turns once, when the tab is opened', async () => {
    respond({ turns: TURNS });

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useMeetingTranscript(MEETING_ID, enabled),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(result.current.state.status).toBe('success');
    });
    if (result.current.state.status !== 'success') throw new Error('unreachable');
    expect(result.current.state.turns).toHaveLength(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      `/meetings/${MEETING_ID}/transcript`,
    );

    // Leaving the tab and coming back must not re-fetch a transcript that cannot
    // change: the call is over.
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays idle without a meeting id, and without a session', () => {
    const { result: noId } = renderHook(() => useMeetingTranscript(null, true));
    expect(noId.current.state.status).toBe('idle');

    auth.value = { status: 'signed-out' };
    const { result: noSession } = renderHook(() =>
      useMeetingTranscript(MEETING_ID, true),
    );
    expect(noSession.current.state.status).toBe('idle');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says what went wrong instead of showing an empty transcript', async () => {
    respond({}, false, 500);

    const { result } = renderHook(() => useMeetingTranscript(MEETING_ID, true));

    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });
    // An empty `turns` array is a LEGITIMATE answer (a call where nobody spoke),
    // so a failure must never land as one.
    if (result.current.state.status !== 'error') throw new Error('unreachable');
    expect(result.current.state.message).toContain('500');
  });

  it('rejects a body that is not the transcript shape, in words a person reads', async () => {
    respond({ turns: [{ speaker: 'me' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { result } = renderHook(() => useMeetingTranscript(MEETING_ID, true));

    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });
    if (result.current.state.status !== 'error') throw new Error('unreachable');
    // A serialized ZodError is a diagnostic, not a sentence — it goes to the log,
    // with FIELD PATHS only, and never carries a transcript line with it.
    expect(result.current.state.message).toBe(
      'Nova sent something this version of the app could not read.',
    );
    expect(result.current.state.message).not.toMatch(/invalid_type|zod|\[/i);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('Thanks for making');
    warn.mockRestore();
  });

  it('gives up on a hung request instead of turning forever', async () => {
    vi.useFakeTimers();
    // Never settles: the failure this ceiling exists for.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const { result } = renderHook(() => useMeetingTranscript(MEETING_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    vi.useRealTimers();

    if (result.current.state.status !== 'error') throw new Error('unreachable');
    expect(result.current.state.message).toBe(
      'The request took too long. Check your connection and try again.',
    );
  });

  it('says a missing meeting in words, not in a status code', async () => {
    // A 404 is the one failure with a cause the user can act on — the call is gone
    // or deleted — so it gets a sentence rather than `server returned HTTP 404`.
    respond({}, false, 404);

    const { result } = renderHook(() => useMeetingTranscript(MEETING_ID, true));

    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });
    if (result.current.state.status !== 'error') throw new Error('unreachable');
    expect(result.current.state.message).toBe('This meeting is no longer available.');
  });

  it('can be asked again after a failure', async () => {
    // The read is LATCHED to the tab, so without this the first failure makes the
    // transcript unreachable for as long as the screen is open.
    respond({}, false, 500);

    const { result } = renderHook(() => useMeetingTranscript(MEETING_ID, true));
    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });

    respond({ turns: TURNS });
    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('success');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
