import {
  LIVE_PROTOCOL_VERSION,
  serverLiveEventSchema,
  type LiveMode,
  type ServerLiveEvent,
} from '@nova/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { liveSocketUrl } from '@/constants/live';
import { useAuth } from '@/hooks/use-auth';
import { supabase } from '@/lib/supabase';

/**
 * Smart hook that OWNS the live-call socket (guardrails: screens dumb, hooks
 * smart). It maps the server wire events onto two view surfaces — a compact
 * scrolling transcript and the COPILOT HISTORY (decision 2026-07-22, Gustavo's
 * direction after sim testing): a chat-log of suggestions rather than a single
 * replace-in-place pane, so earlier answers stay readable by scrolling.
 *
 * History contract (design: live-pipeline.md §Mobile):
 *   - suggestion.start   → APPEND a new entry (previous entries untouched)
 *   - suggestion.delta   → stream into the entry with that id (tokens visible
 *                          immediately; batched to ONE state update per
 *                          animation frame via a ref buffer)
 *   - suggestion.done    → finalize that entry's text
 *   - suggestion.discard → remove ONLY that entry (in-flight speculation miss);
 *                          previous answers keep
 *
 * `start()` creates a meeting through the existing supabase seam (RLS
 * `meetings_insert_own`) and connects the REAL authed socket; `sendInput`
 * then drives `transcript.input` — the typed-question product surface — and the
 * streamed answer is a real LLM suggestion. There is NO canned/replay path
 * (removed 2026-07-23 at Gustavo's direction — every suggestion on this screen
 * is a real one). Real mic capture is Phase 8/9.
 */

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error';

export interface LiveSuggestion {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly streaming: boolean;
}

export interface LiveTranscriptTurn {
  readonly id: string;
  readonly speaker: string | null;
  readonly text: string;
}

export interface LiveSessionState {
  readonly status: LiveStatus;
  /** Human-readable reason when something went wrong (typed server errors too). */
  readonly errorMessage: string | null;
  readonly transcript: readonly LiveTranscriptTurn[];
  /** The copilot HISTORY, oldest first; the newest entry may be streaming. */
  readonly suggestions: readonly LiveSuggestion[];
  /** True when the real socket is live and typed input can be sent. */
  readonly canSend: boolean;
  /** The copilot mode the NEXT session will start with (`general` by default). */
  readonly mode: LiveMode;
  /**
   * Whether the mode can still be changed. Mode is per call — the server locks it
   * at `session.start` so the assembled prompt prefix stays byte-stable — so this
   * goes false the moment a session is connecting or live.
   */
  readonly canPickMode: boolean;
}

export interface UseLiveSession extends LiveSessionState {
  /** Create a meeting + connect the real authed socket. */
  start: () => Promise<void>;
  /** Pick the copilot mode for the next call. Ignored while one is in flight. */
  setMode: (mode: LiveMode) => void;
  /** Send a typed utterance/question (`transcript.input`) up the live socket. */
  sendInput: (text: string) => void;
  /** End the session (closes the socket). */
  stop: () => void;
}

export function useLiveSession(): UseLiveSession {
  const auth = useAuth();

  const [status, setStatus] = useState<LiveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<readonly LiveTranscriptTurn[]>([]);
  const [suggestions, setSuggestions] = useState<readonly LiveSuggestion[]>([]);
  const [mode, setModeState] = useState<LiveMode>('general');

  // The lock is derived from status, not tracked separately: "a call is in
  // flight" already has one source of truth and a second one would drift.
  const canPickMode = status !== 'connecting' && status !== 'live';

  const socketRef = useRef<WebSocket | null>(null);
  const turnSeq = useRef(0);

  // Streaming buffer for the CURRENT in-flight entry + one-flush-per-frame
  // scheduler (refs, not state, so token appends never trigger a render — the
  // rAF flush does, at most once per frame).
  const streamIdRef = useRef<string | null>(null);
  const bufferRef = useRef('');
  const frameRef = useRef<number | null>(null);

  const cancelFrame = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback((): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const id = streamIdRef.current;
      const text = bufferRef.current;
      if (id === null) return;
      setSuggestions((prev) =>
        prev.map((s) => (s.id === id && s.streaming ? { ...s, text } : s)),
      );
    });
  }, []);

  const applyEvent = useCallback(
    (event: ServerLiveEvent): void => {
      switch (event.type) {
        case 'session.ready':
          setStatus('live');
          return;
        case 'transcript.final':
          turnSeq.current += 1;
          setTranscript((prev) => [
            ...prev,
            {
              id: `t${String(turnSeq.current)}`,
              speaker: event.speaker,
              text: event.text,
            },
          ]);
          return;
        case 'suggestion.start':
          // APPEND a new history entry — never erase the previous answers.
          cancelFrame();
          streamIdRef.current = event.suggestion_id;
          bufferRef.current = '';
          setSuggestions((prev) => [
            ...prev,
            {
              id: event.suggestion_id,
              kind: event.kind,
              text: '',
              streaming: true,
            },
          ]);
          return;
        case 'suggestion.delta':
          if (streamIdRef.current === event.suggestion_id) {
            bufferRef.current += event.text;
            scheduleFlush();
          }
          return;
        case 'suggestion.done':
          cancelFrame();
          if (streamIdRef.current === event.suggestion_id) {
            streamIdRef.current = null;
            bufferRef.current = '';
          }
          setSuggestions((prev) =>
            prev.map((s) =>
              s.id === event.suggestion_id
                ? { ...s, text: event.text, streaming: false }
                : s,
            ),
          );
          return;
        case 'suggestion.discard':
          // Remove ONLY the discarded entry; previous answers stay readable.
          cancelFrame();
          if (streamIdRef.current === event.suggestion_id) {
            streamIdRef.current = null;
            bufferRef.current = '';
          }
          setSuggestions((prev) =>
            prev.filter((s) => s.id !== event.suggestion_id),
          );
          return;
        case 'error':
          // Surface typed server errors (quota/paywall SCREENS ride Phase 8).
          setErrorMessage(`${event.code}: ${event.message}`);
          return;
        // transcript.partial / provider_switched / pong / audio.echo: not
        // surfaced by this minimal build (Phase 8 adds interims + status chips).
        default:
          return;
      }
    },
    [cancelFrame, scheduleFlush],
  );

  const reset = useCallback((): void => {
    cancelFrame();
    streamIdRef.current = null;
    bufferRef.current = '';
    setErrorMessage(null);
    setTranscript([]);
    setSuggestions([]);
  }, [cancelFrame]);

  /**
   * Enforced HERE and not only by disabling the pills: the screen's lock is a
   * courtesy, this is the guarantee. A mode changed mid-call would silently
   * disagree with the prompt the server is already committed to for this session.
   */
  const setMode = useCallback(
    (next: LiveMode): void => {
      if (!canPickMode) return;
      setModeState(next);
    },
    [canPickMode],
  );

  const stop = useCallback((): void => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      try {
        socket.send(
          JSON.stringify({ v: LIVE_PROTOCOL_VERSION, type: 'session.end' }),
        );
      } catch {
        // already closed — the server disposer runs on socket close either way
      }
      socket.close();
    }
    cancelFrame();
    setStatus('closed');
  }, [cancelFrame]);

  /** Create a meeting via the supabase seam, connect the real socket. */
  const start = useCallback(async (): Promise<void> => {
    if (auth.status !== 'signed-in' || supabase === null) {
      setStatus('error');
      setErrorMessage('sign in required for a live session');
      return;
    }
    stop();
    reset();
    setStatus('connecting');

    // A meeting row to tie the session to (RLS `meetings_insert_own` — the
    // authenticated user inserts their own row through the existing seam; the
    // server's ownership guard then accepts the session.start).
    const title = `Live session ${new Date().toLocaleString()}`;
    const inserted = await supabase
      .from('meetings')
      .insert({
        user_id: auth.session.user.id,
        title,
        // `started_at` was never set, so EVERY meeting this app created was
        // undatable — surfaced by the Phase 8.5 Meetings screen, which filed all
        // of them under "earlier" and reported "no calls this month" while
        // listing calls from today. `ended_at` was already being stamped (by the
        // session close / stale-call reaper), so duration was unrecoverable too.
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single<{ id: string }>();
    if (inserted.error) {
      setStatus('error');
      setErrorMessage(`could not create a meeting: ${inserted.error.message}`);
      return;
    }
    const meetingId = inserted.data.id;

    const socket = new WebSocket(liveSocketUrl(auth.session.access_token));
    socketRef.current = socket;
    socket.onopen = (): void => {
      socket.send(
        JSON.stringify({
          v: LIVE_PROTOCOL_VERSION,
          type: 'session.start',
          meeting_id: meetingId,
          // Sent even for 'general' (which the server would infer from an absent
          // field) so a captured frame says which prompt answered the call.
          mode,
        }),
      );
    };
    socket.onmessage = (message: WebSocketMessageEvent): void => {
      // why: onerror and onclose below already ignore a superseded socket; this
      // handler did not. A frame still in flight from a previous socket (stop then
      // start again, or a reconnect) applied its transcript lines and suggestion
      // deltas into the CURRENT session's state — the exact bug class the ref
      // guard exists to prevent.
      if (socketRef.current !== socket) return;
      let json: unknown;
      try {
        json = JSON.parse(String(message.data));
      } catch {
        return; // non-JSON — ignore in the minimal client
      }
      const parsed = serverLiveEventSchema.safeParse(json);
      if (parsed.success) applyEvent(parsed.data);
    };
    socket.onerror = (): void => {
      if (socketRef.current === socket) {
        setStatus('error');
        setErrorMessage('connection error — is the server running?');
      }
    };
    socket.onclose = (event: WebSocketCloseEvent): void => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        // A close the USER didn't ask for must say why (policy closes carry an
        // app code + reason, e.g. 4401 auth / 4503 unavailable) — a silent
        // "session ended" right after Start is undebuggable from the phone.
        if (event.code !== 1000) {
          setStatus('error');
          setErrorMessage(
            `session closed by server (${String(event.code)}${
              typeof event.reason === 'string' && event.reason !== ''
                ? `: ${event.reason}`
                : ''
            })`,
          );
        } else {
          setStatus('closed');
        }
      }
    };
  }, [auth, stop, reset, applyEvent, mode]);

  /**
   * Send what the user typed on the "Test Live" screen. That screen is a
   * DEVELOPER surface (role-gated to developer/admin, adr-0008) whose job is to
   * stand in for the mic until real capture lands in Phase 8/9 — so a typed line
   * means "the other party said this", and goes up as `origin: "utterance"`.
   * It is attributed to "them", persisted, and run through the trigger gate,
   * which is exactly what makes the copilot behave as it would on a real call
   * and what makes post-call notes testable without speaking.
   *
   * The sibling `origin: "copilot_question"` (answered but never persisted)
   * exists on the wire and is server-tested; it belongs to the real product
   * surface — "ask your copilot something mid-call" — not to this dev tool.
   */
  const sendInput = useCallback((text: string): void => {
    const trimmed = text.trim();
    const socket = socketRef.current;
    if (
      trimmed === '' ||
      socket === null ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    socket.send(
      JSON.stringify({
        v: LIVE_PROTOCOL_VERSION,
        type: 'transcript.input',
        text: trimmed.slice(0, 2000),
        origin: 'utterance',
      }),
    );
  }, []);

  // Teardown on unmount: close the socket / cancel the frame exactly once.
  useEffect(() => {
    return () => {
      cancelFrame();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [cancelFrame]);

  return {
    status,
    errorMessage,
    transcript,
    suggestions,
    // 'live' is only ever set by session.ready on the real socket.
    canSend: status === 'live',
    mode,
    canPickMode,
    start,
    setMode,
    sendInput,
    stop,
  };
}
