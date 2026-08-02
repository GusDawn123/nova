import { meetingListResponseSchema, type MeetingListResponse } from '@nova/shared';
import { useCallback, useEffect, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

const MEETINGS_URL = `${API_BASE_URL}/meetings`;

/**
 * A request still unanswered here is hung, not slow: without a ceiling the promise
 * never settles, so `refreshing` never clears and the spinner turns forever.
 */
const REQUEST_TIMEOUT_MS = 10_000;

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
 * shared schema. Screens stay dumb (RULES §10).
 *
 * Re-runs when the token changes (a silent refresh mints a new one), which also
 * means the list reloads after re-auth rather than showing a stale page behind a
 * dead token.
 */
export function useMeetings(): UseMeetings {
  const auth = useAuth();
  const accessToken =
    auth.status === 'signed-in' ? auth.session.access_token : null;

  const [fetched, setFetched] = useState<MeetingsState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by refresh() to re-run the effect; a counter rather than a boolean so
  // two refreshes in a row both take effect.
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    // Signed out there is nothing to fetch and the effect below early-returns,
    // so setting `refreshing` here would leave the spinner stuck on forever.
    if (accessToken === null) return;
    setRefreshing(true);
    setNonce((n) => n + 1);
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
          setFetched({
            status: 'error',
            message: timedOut ? TIMEOUT_MESSAGE : failureMessage(error),
          });
        }
      } finally {
        clearTimeout(timer);
        if (!cancelled) setRefreshing(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, nonce]);

  // Signed-out is derived, not stored: it is a pure function of the session, and a
  // stored copy could disagree with it for a render.
  const state: MeetingsState =
    accessToken === null ? { status: 'signed-out' } : fetched;

  return { state, refresh, refreshing };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed';
}
