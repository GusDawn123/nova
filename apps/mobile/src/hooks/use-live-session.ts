import {
  LIVE_PROTOCOL_VERSION,
  serverLiveEventSchema,
  type ServerLiveEvent,
} from '@nova/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { liveSocketUrl } from '@/constants/live';
import {
  applyNotesUpdate,
  emptyLiveNotes,
  markLiveNotesSeen,
  type LiveNotesState,
} from '@/features/notes/notes-update';
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
  /**
   * Live notes for this call, reduced through the rev rule (§5.3). `hasUnseen`
   * drives the unread dot on the capture card's hidden tab (§5.1).
   */
  readonly liveNotes: LiveNotesState;
}

export interface UseLiveSession extends LiveSessionState {
  /** Create a meeting + connect the real authed socket. */
  start: () => Promise<void>;
  /** Send a typed utterance/question (`transcript.input`) up the live socket. */
  sendInput: (text: string) => void;
  /** End the session (closes the socket). */
  stop: () => void;
  /** Clear the unread dot — the live-notes panel just became visible. */
  markNotesSeen: () => void;
}

export interface UseLiveSessionOptions {
  /**
   * Whether the live-notes panel is on screen right now. Read at APPLY time from a
   * ref, not closed over: an update that lands while the user is reading the
   * transcript tab is exactly what the unread dot exists for, and a stale closure
   * would mark it seen anyway.
   */
  readonly notesPanelVisible?: boolean;
}

export function useLiveSession(
  options: UseLiveSessionOptions = {},
): UseLiveSession {
  const auth = useAuth();

  const [status, setStatus] = useState<LiveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<readonly LiveTranscriptTurn[]>([]);
  const [suggestions, setSuggestions] = useState<readonly LiveSuggestion[]>([]);
  const [liveNotes, setLiveNotes] = useState<LiveNotesState>(emptyLiveNotes);

  const notesVisibleRef = useRef(options.notesPanelVisible ?? false);
  useEffect(() => {
    notesVisibleRef.current = options.notesPanelVisible ?? false;
  }, [options.notesPanelVisible]);

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
        case 'notes.update':
          // The rev rule lives in ONE place (§5.3) and is already proven; this is
          // only the routing. A dropped update returns the same object reference,
          // so a re-emit across a reconnect costs no render.
          setLiveNotes((prev) =>
            applyNotesUpdate(
              prev,
              { notes: event.notes, rev: event.rev },
              notesVisibleRef.current,
            ),
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
    // A new call starts with no notes and no unread dot. Carrying the previous
    // call's rev forward would silently drop the next call's early updates, since
    // revs are per-meeting and restart at 0.
    setLiveNotes(emptyLiveNotes);
  }, [cancelFrame]);

  const markNotesSeen = useCallback((): void => {
    setLiveNotes((prev) => markLiveNotesSeen(prev));
  }, []);

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
  }, [auth, stop, reset, applyEvent]);

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
    liveNotes,
    start,
    sendInput,
    stop,
    markNotesSeen,
  };
}
