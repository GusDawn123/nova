import {
  meetingTranscriptResponseSchema,
  type MeetingTranscriptTurn,
} from '@nova/shared';
import { useCallback, useEffect, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

/**
 * A request still unanswered here is hung, not slow: without a ceiling the promise
 * never settles, so the panel's ring turns forever with nothing behind it.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const TIMEOUT_MESSAGE =
  'The request took too long. Check your connection and try again.';
/** Fixed copy: a serialized ZodError is a diagnostic, not a sentence for a user. */
const SCHEMA_MESSAGE =
  'Nova sent something this version of the app could not read.';

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
  /**
   * Run the read again — the only way out of a failure. The load below is latched
   * to the tab and fires once, so without this a first failed request would make
   * the transcript unreachable for as long as the screen is open.
   */
  retry: () => void;
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

  // A counter rather than a boolean, so two retries in a row both take effect.
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!armed || accessToken === null || meetingId === null) return;

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
      setState({ status: 'loading' });
      try {
        const response = await fetch(
          `${API_BASE_URL}/meetings/${String(meetingId)}/transcript`,
          {
            headers: { Authorization: `Bearer ${String(accessToken)}` },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? 'This meeting is no longer available.'
              : `server returned HTTP ${String(response.status)}`,
          );
        }
        const body: unknown = await response.json();
        const parsed = meetingTranscriptResponseSchema.safeParse(body);
        if (!parsed.success) {
          // Field paths only. This response is nothing BUT transcript lines, so a
          // dumped issue list would put the call's contents into the log.
          console.warn(
            'transcript response failed to parse',
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
            })),
          );
          throw new Error(SCHEMA_MESSAGE);
        }
        // An EMPTY array is a real answer — a call where nobody spoke — so it lands
        // as success. Only a failure may render as "we could not read this".
        if (!cancelled) {
          setState({ status: 'success', turns: parsed.data.turns });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: timedOut ? TIMEOUT_MESSAGE : failureMessage(error),
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, meetingId, armed, nonce]);

  return { state, retry };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed';
}
