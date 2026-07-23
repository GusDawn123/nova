import {
  LIVE_PROTOCOL_VERSION,
  serverLiveEventSchema,
  type ServerLiveEvent,
} from '@nova/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { liveSocketUrl } from '@/constants/live';

/**
 * Smart hook that OWNS the live-call socket (guardrails: screens dumb, hooks
 * smart). It maps the server wire events 1:1 onto two view surfaces — a fixed
 * single streaming copilot pane and a separate scrolling transcript — and never
 * exposes the socket itself. Screens render the returned state; they never touch
 * `WebSocket` or `@nova/shared` schemas.
 *
 * Streaming-pane contract (design: live-pipeline.md §Mobile):
 *   - suggestion.start   → replace the pane content in place (new focal answer)
 *   - suggestion.delta   → append tokens as they arrive (visible immediately);
 *                          batched to ONE state update per animation frame via a
 *                          ref buffer so a fast token stream can't thrash React
 *   - suggestion.done    → the final, format-upgraded body
 *   - suggestion.discard → clear the pane INSTANTLY (never a zombie card)
 *
 * Audio capture (mic → binary frames) is Phase 8/9; this minimal build connects
 * for real when given a token+meeting, and supports a `replay` fixture so the
 * pane can be demoed in the simulator without a mic (the same reducer feeds both).
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
  readonly transcript: readonly LiveTranscriptTurn[];
  /** The single focal-pane suggestion, or null when the pane is clear. */
  readonly suggestion: LiveSuggestion | null;
}

/** One scripted event for the mic-less simulator demo (replayed over time). */
export interface LiveReplayStep {
  readonly delayMs: number;
  readonly event: ServerLiveEvent;
}

export interface UseLiveSessionOptions {
  /** Supabase access token (real socket). Omit to stay idle or use `replay`. */
  readonly accessToken?: string;
  /** The meeting this session is tied to (real socket). */
  readonly meetingId?: string;
  /** Dev/demo: replay these events locally instead of opening a socket. */
  readonly replay?: readonly LiveReplayStep[];
}

export function useLiveSession(opts: UseLiveSessionOptions): LiveSessionState {
  const { accessToken, meetingId, replay } = opts;

  const [status, setStatus] = useState<LiveStatus>('idle');
  const [transcript, setTranscript] = useState<readonly LiveTranscriptTurn[]>([]);
  const [suggestion, setSuggestion] = useState<LiveSuggestion | null>(null);

  // Streaming buffer + one-flush-per-frame scheduler (refs, not state, so token
  // appends never trigger a render — the rAF flush does, at most once per frame).
  const bufferRef = useRef('');
  const frameRef = useRef<number | null>(null);
  const turnSeq = useRef(0);

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
      const text = bufferRef.current;
      setSuggestion((prev) => (prev ? { ...prev, text } : prev));
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
          cancelFrame();
          bufferRef.current = '';
          setSuggestion({
            id: event.suggestion_id,
            kind: event.kind,
            text: '',
            streaming: true,
          });
          return;
        case 'suggestion.delta':
          bufferRef.current += event.text;
          scheduleFlush();
          return;
        case 'suggestion.done':
          cancelFrame();
          bufferRef.current = event.text;
          setSuggestion((prev) =>
            prev && prev.id === event.suggestion_id
              ? { ...prev, text: event.text, streaming: false }
              : prev,
          );
          return;
        case 'suggestion.discard':
          cancelFrame();
          bufferRef.current = '';
          setSuggestion((prev) =>
            prev && prev.id === event.suggestion_id ? null : prev,
          );
          return;
        // transcript.partial / provider_switched / error / pong / audio.echo:
        // not surfaced by the minimal pane (Phase 8 adds interim + status chips).
        default:
          return;
      }
    },
    [cancelFrame, scheduleFlush],
  );

  // Reset the view surfaces when a new session begins. Deferred to a macrotask so
  // it is not a synchronous setState in the effect body (React 19 cascade rule);
  // the tiny defer is invisible next to network/replay timing.
  const resetSurfaces = useCallback((): ReturnType<typeof setTimeout> => {
    return setTimeout(() => {
      setStatus('connecting');
      setTranscript([]);
      setSuggestion(null);
    }, 0);
  }, []);

  // Replay mode: schedule the fixture events, no socket. Used for the sim demo.
  useEffect(() => {
    if (!replay) return;
    const timers: ReturnType<typeof setTimeout>[] = [resetSurfaces()];
    let elapsed = 0;
    for (const step of replay) {
      elapsed += step.delayMs;
      timers.push(setTimeout(() => applyEvent(step.event), elapsed));
    }
    timers.push(setTimeout(() => setStatus('closed'), elapsed + 50));
    return () => {
      cancelFrame();
      for (const t of timers) clearTimeout(t);
    };
  }, [replay, applyEvent, cancelFrame, resetSurfaces]);

  // Real socket mode.
  useEffect(() => {
    if (replay || accessToken === undefined || meetingId === undefined) return;
    const initTimer = resetSurfaces();
    const socket = new WebSocket(liveSocketUrl(accessToken));

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
      let json: unknown;
      try {
        json = JSON.parse(String(message.data));
      } catch {
        return; // non-JSON (binary echo etc.) — ignore in the minimal client
      }
      const parsed = serverLiveEventSchema.safeParse(json);
      if (parsed.success) applyEvent(parsed.data);
    };
    socket.onerror = (): void => setStatus('error');
    socket.onclose = (): void => setStatus('closed');

    return () => {
      clearTimeout(initTimer);
      cancelFrame();
      socket.close();
    };
  }, [accessToken, meetingId, replay, applyEvent, cancelFrame, resetSurfaces]);

  return { status, transcript, suggestion };
}
