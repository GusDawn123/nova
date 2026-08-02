import {
  meetingTranscriptResponseSchema,
  type MeetingTranscriptTurn,
} from '@nova/shared';
import { useEffect, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

/**
 * The transcript read behind the detail screen's second tab
 * (`GET /meetings/:id/transcript`).
 *
 * SEPARATE from `useMeetingNotes` on purpose, and the server draws the same line
 * (`modules/meetings/routes.ts`): notes are polled while a call folds and are small,
 * transcripts are the longest thing this API returns and most opens of a meeting
 * never look at one. So this hook stays `idle` until the tab is actually opened, and
 * having loaded once it does not load again — the call is over, and a transcript of
 * a finished call cannot change.
 *
 * The idle contract is `useMeetingNotes`': no session or no meeting id means NO
 * request, rather than a request with `null` interpolated into its URL.
 */
export type MeetingTranscriptState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; turns: MeetingTranscriptTurn[] }
  | { status: 'error'; message: string };

export interface UseMeetingTranscript {
  state: MeetingTranscriptState;
}

export function useMeetingTranscript(
  meetingId: string | null,
  enabled: boolean,
): UseMeetingTranscript {
  const auth = useAuth();
  const accessToken =
    auth.status === 'signed-in' ? auth.session.access_token : null;

  const [state, setState] = useState<MeetingTranscriptState>({
    status: 'idle',
  });

  // `enabled` is a LATCH, not a switch: once the tab has been opened the read is
  // armed for good. Adjusted during render rather than in an effect — that is this
  // repo's rule for prop-derived state (`react-hooks/set-state-in-effect` is an
  // error), and it also means the fetch starts on the frame the tab opens rather
  // than one after.
  const [armed, setArmed] = useState(false);
  if (enabled && !armed) setArmed(true);

  useEffect(() => {
    if (!armed || accessToken === null || meetingId === null) return;
    let cancelled = false;

    async function load(): Promise<void> {
      setState({ status: 'loading' });
      try {
        const response = await fetch(
          `${API_BASE_URL}/meetings/${String(meetingId)}/transcript`,
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
        const data = meetingTranscriptResponseSchema.parse(body);
        // An EMPTY array is a real answer — a call where nobody spoke — so it lands
        // as success. Only a failure may render as "we could not read this".
        if (!cancelled) setState({ status: 'success', turns: data.turns });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'request failed',
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, meetingId, armed]);

  return { state };
}
