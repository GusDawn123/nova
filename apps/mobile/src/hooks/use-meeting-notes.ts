import { notesReadResponseSchema, type NotesReadResponse } from '@nova/shared';
import { useCallback, useEffect, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

/**
 * The meeting detail read (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.5), plus the
 * action-item completion write.
 *
 * The read model carries the post-call `notes` and their `notes_status`; the
 * screen branches only on the status, for the pill and the retry.
 */
export type MeetingNotesState =
  | { status: 'loading' }
  | { status: 'success'; data: NotesReadResponse }
  | { status: 'error'; message: string };

export interface UseMeetingNotes {
  state: MeetingNotesState;
  /** Ids currently checked, including an optimistic toggle not yet confirmed. */
  completedIds: Set<string>;
  /** Toggle an action item; reverts if the server rejects it. */
  toggleItem: (itemId: string, completed: boolean) => void;
  refresh: () => void;
}

/**
 * `meetingId` is null when the route param did not parse as a meeting id. The hook
 * then stays idle — no fetch, no write — rather than putting a bad id in a URL.
 */
export function useMeetingNotes(meetingId: string | null): UseMeetingNotes {
  const auth = useAuth();
  const accessToken =
    auth.status === 'signed-in' ? auth.session.access_token : null;

  const [fetched, setFetched] = useState<MeetingNotesState>({ status: 'loading' });
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    // No token: nothing to fetch. DERIVED below rather than pushed through
    // setState — setting state synchronously inside an effect cascades a render
    // for a value that is a pure function of the session.
    if (accessToken === null || meetingId === null) return;
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch(
          `${API_BASE_URL}/meetings/${meetingId}/notes`,
          { headers: { Authorization: `Bearer ${String(accessToken)}` } },
        );
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? 'This meeting is no longer available.'
              : `server returned HTTP ${String(response.status)}`,
          );
        }
        const body: unknown = await response.json();
        const data = notesReadResponseSchema.parse(body);
        if (!cancelled) {
          setFetched({ status: 'success', data });
          // The server is authoritative: it has already dropped completions whose
          // item text no longer matches, so this REPLACES local state rather than
          // merging into it. Merging would resurrect exactly the stale checkmarks
          // the staleness guard just discarded.
          setCompletedIds(new Set(data.completed_item_ids));
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : 'request failed';
          setFetched({ status: 'error', message });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, meetingId, nonce]);

  const toggleItem = useCallback(
    (itemId: string, completed: boolean) => {
      if (accessToken === null || meetingId === null) return;

      // Optimistic: the checkbox must feel instant. Reverted below on failure.
      setCompletedIds((prev) => {
        const next = new Set(prev);
        if (completed) next.add(itemId);
        else next.delete(itemId);
        return next;
      });

      void (async () => {
        try {
          const response = await fetch(
            `${API_BASE_URL}/meetings/${meetingId}/notes/items/${itemId}`,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${String(accessToken)}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ completed }),
            },
          );
          if (!response.ok) throw new Error(String(response.status));
        } catch {
          // Revert. A checkbox that silently stays checked after a failed write is
          // the same lie as one that unchecks itself on refresh — the user would
          // believe the state is saved when it is not.
          setCompletedIds((prev) => {
            const next = new Set(prev);
            if (completed) next.delete(itemId);
            else next.add(itemId);
            return next;
          });
        }
      })();
    },
    [accessToken, meetingId],
  );

  // Signed-out is derived, not stored: a pure function of the session.
  const state: MeetingNotesState =
    accessToken === null
      ? { status: 'error', message: 'not signed in' }
      : fetched;

  return { state, completedIds, toggleItem, refresh };
}
