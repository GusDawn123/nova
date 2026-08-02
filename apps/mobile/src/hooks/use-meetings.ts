import { meetingListResponseSchema, type MeetingListResponse } from '@nova/shared';
import { useCallback, useEffect, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

const MEETINGS_URL = `${API_BASE_URL}/meetings`;

/**
 * The Meetings list round trip (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.5).
 * Discriminated union so the screen renders exactly one branch — the same shape as
 * `use-me` / `use-health`.
 */
export type MeetingsState =
  | { status: 'loading' }
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

    async function load(): Promise<void> {
      try {
        const response = await fetch(MEETINGS_URL, {
          headers: { Authorization: `Bearer ${String(accessToken)}` },
        });
        if (!response.ok) {
          throw new Error(`server returned HTTP ${String(response.status)}`);
        }
        const body: unknown = await response.json();
        const data = meetingListResponseSchema.parse(body);
        if (!cancelled) setFetched({ status: 'success', data });
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : 'request failed';
          setFetched({ status: 'error', message });
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, nonce]);

  // Signed-out is derived, not stored: it is a pure function of the session, and a
  // stored copy could disagree with it for a render.
  const state: MeetingsState =
    accessToken === null
      ? { status: 'error', message: 'not signed in' }
      : fetched;

  return { state, refresh, refreshing };
}
