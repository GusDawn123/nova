import {
  meetingListResponseSchema,
  type MeetingListResponse,
  type NotesStatus,
} from '@nova/shared';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

const MEETINGS_URL = `${API_BASE_URL}/meetings`;

/**
 * A request still unanswered here is hung, not slow: without a ceiling the promise
 * never settles, so `refreshing` never clears and the spinner turns forever.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How often the list re-reads itself while the notes pipeline is still writing.
 * Slow enough to be invisible on a bill, quick enough that WRITING NOTES → NOTES
 * READY lands while the user is still looking at the card.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * Which `notes_status` values mean "a job is still working on this". A `Record`
 * rather than a list so a sixth status has to be classified HERE to compile,
 * instead of quietly defaulting to "settled" and never being polled for.
 *
 * `failed` is settled on purpose: the retry is a button, not a timer.
 */
const NOTES_STILL_WRITING: Record<NotesStatus, boolean> = {
  none: false,
  queued: true,
  processing: true,
  completed: false,
  failed: false,
};

const TIMEOUT_MESSAGE =
  'The request took too long. Check your connection and try again.';
/** Fixed copy: a serialized ZodError is a diagnostic, not a sentence for a user. */
const SCHEMA_MESSAGE =
  'Nova sent something this version of the app could not read.';

/**
 * The Meetings list round trip (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.5).
 * Discriminated union so the screen renders exactly one branch — the same shape as
 * `use-me` / `use-health`.
 *
 * `signed-out` is its OWN branch rather than an error with a message: an error card
 * offers a retry, and nothing this hook can retry will produce a session.
 */
export type MeetingsState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'success'; data: MeetingListResponse }
  | { status: 'error'; message: string };

/**
 * One trip to the server. `silent` is not cosmetic: it is the difference between a
 * failure the user is owed an explanation for (the first load, a pull-to-refresh)
 * and one they must never be shown (a poll tick, a return to the tab).
 */
interface Request {
  readonly n: number;
  readonly silent: boolean;
}

export interface UseMeetings {
  state: MeetingsState;
  /**
   * Re-fetch WITHOUT dropping back to the loading branch, so a pull-to-refresh or a
   * focus refresh updates in place instead of blanking a list the user is reading.
   */
  refresh: () => void;
  /** True while a `refresh()` is in flight (drives the spinner, not the skeleton). */
  refreshing: boolean;
}

/**
 * Smart hook: `GET /meetings` with the caller's access token, zod-parsed against the
 * shared schema. Screens stay dumb (RULES §10) — including about FRESHNESS, which
 * this hook owns end to end.
 *
 * Re-runs when the token changes (a silent refresh mints a new one), which also
 * means the list reloads after re-auth rather than showing a stale page behind a
 * dead token.
 *
 * Three things make a request, and only one of them is the user:
 *
 *   MOUNT — once, for the screen's first paint.
 *   FOCUS — a tab screen is never unmounted, so returning from a call would
 *     otherwise show the list as it looked before the call happened.
 *   POLL — notes are written by a background job (`modules/notes`), so without a
 *     timer the WRITING NOTES → NOTES READY transition could never reach the card.
 *
 * The last two are SILENT in both directions: they update in place and never touch
 * `refreshing` (which belongs to the pull-to-refresh spinner alone), and when they
 * FAIL they leave the last good list exactly where it was. Only a fetch the user
 * asked for is allowed to put an error card on screen.
 */
export function useMeetings(): UseMeetings {
  const auth = useAuth();
  const accessToken =
    auth.status === 'signed-in' ? auth.session.access_token : null;

  const [fetched, setFetched] = useState<MeetingsState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  /**
   * The request to run. `n` re-runs the effect — a counter rather than a boolean so
   * two refreshes in a row both take effect — and `silent` says whether a HUMAN
   * asked for it, which is what decides whether a failure is allowed on screen.
   * Carried as one object so the two can never disagree about the same request.
   */
  const [request, setRequest] = useState<Request>({ n: 0, silent: false });
  // Focus is STATE, not a ref: the poll below has to start and stop with it.
  const [focused, setFocused] = useState(false);
  /**
   * Whether a fetch has ever landed. The focus that arrives in the same commit as
   * the mount is the same event as the mount, and firing both would double every
   * cold open of the screen.
   */
  const settled = useRef(false);

  /**
   * Re-fetch without saying so: bumping the request re-runs the effect below, whose
   * cleanup aborts whatever it superseded — so overlapping polls cannot stack. A
   * failure here is swallowed rather than rendered (see the `catch`).
   *
   * Deliberately dependency-FREE: `useFocusEffect` re-runs its effect whenever the
   * callback identity changes, and a callback that changed per render would refetch
   * per render.
   */
  const refetch = useCallback(() => {
    setRequest((prev) => ({ n: prev.n + 1, silent: true }));
  }, []);

  const refresh = useCallback(() => {
    // Signed out there is nothing to fetch and the effect below early-returns,
    // so setting `refreshing` here would leave the spinner stuck on forever.
    if (accessToken === null) return;
    setRefreshing(true);
    setRequest((prev) => ({ n: prev.n + 1, silent: false }));
  }, [accessToken]);

  useEffect(() => {
    // No token: nothing to fetch. DERIVED below rather than pushed through
    // setState — setting state synchronously inside an effect cascades a render
    // for a value that is a pure function of the session.
    if (accessToken === null) return;

    let cancelled = false;
    const controller = new AbortController();
    // Distinguishes the two aborts: the timeout is something to tell the user
    // about, the cleanup abort is a render that no longer exists.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    async function load(): Promise<void> {
      try {
        const response = await fetch(MEETINGS_URL, {
          headers: { Authorization: `Bearer ${String(accessToken)}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`server returned HTTP ${String(response.status)}`);
        }
        const body: unknown = await response.json();
        const parsed = meetingListResponseSchema.safeParse(body);
        if (!parsed.success) {
          // Field paths only — a transcript or a title must never reach the log.
          console.warn(
            'meetings response failed to parse',
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
            })),
          );
          throw new Error(SCHEMA_MESSAGE);
        }
        if (!cancelled) setFetched({ status: 'success', data: parsed.data });
      } catch (error) {
        if (!cancelled) {
          setFetched((previous) => {
            // A request the user never made may not take away the list they are
            // reading. One 500 on a poll tick, one Wi-Fi→LTE handoff on the way
            // back to this tab, and the whole archive would otherwise be replaced
            // by an error card nobody asked for — and, because the poll is gated
            // on the success data, the WRITING NOTES → NOTES READY transition
            // would die with it. Keep the last good answer; the next tick heals.
            if (request.silent && previous.status === 'success') return previous;
            return {
              status: 'error',
              message: timedOut ? TIMEOUT_MESSAGE : failureMessage(error),
            };
          });
        }
      } finally {
        clearTimeout(timer);
        if (!cancelled) {
          settled.current = true;
          setRefreshing(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, request]);

  /**
   * Focus. The cleanup runs on BLUR, not on unmount — that is the whole reason this
   * is `useFocusEffect` and not `useEffect`, and it is what stops the poll below for
   * a screen the user has navigated away from.
   *
   * The refetch is skipped while the first load is still in flight: that focus IS
   * the mount. An error left by an earlier attempt is retried by it, which is the
   * behaviour we want — a failed list heals by being looked at again.
   */
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      if (settled.current) refetch();
      return () => {
        setFocused(false);
      };
    }, [refetch]),
  );

  /**
   * Poll, for exactly as long as there is something to poll for. A boolean, not the
   * meetings array, so the interval keeps its cadence across refetches instead of
   * being torn down and restarted by every answer that changes nothing.
   *
   * This reads the last GOOD list — a silent failure never overwrites it — so one
   * bad tick cannot switch the poll off and strand the card on WRITING NOTES.
   */
  const writingNotes =
    fetched.status === 'success' &&
    fetched.data.meetings.some((meeting) => NOTES_STILL_WRITING[meeting.notes_status]);

  useEffect(() => {
    // Unfocused, signed out, or nothing being written: no timer exists at all. A
    // poll that outlives its reason is a request the user never sees and pays for.
    if (!focused || accessToken === null || !writingNotes) return;
    const ticker = setInterval(() => {
      refetch();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(ticker);
    };
  }, [focused, accessToken, writingNotes, refetch]);

  // Signed-out is derived, not stored: it is a pure function of the session, and a
  // stored copy could disagree with it for a render.
  const state: MeetingsState =
    accessToken === null ? { status: 'signed-out' } : fetched;

  return { state, refresh, refreshing };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed';
}
