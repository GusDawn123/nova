import { useEffect, useRef, useState } from "react";

/**
 * The renderer's picture of the live call, built entirely from main's
 * `liveEvent` pushes. The renderer never owns the session — it renders what
 * main reports, exactly like the screen-privacy eye.
 *
 * Transcript model: FINAL lines accumulate; each speaker has at most ONE
 * in-flight partial that later events replace (a partial is a hypothesis, and
 * stacking hypotheses would render every sentence three times as it forms).
 */

export interface TranscriptRow {
  readonly key: string;
  readonly speaker: string | null;
  readonly text: string;
  readonly tsMs: number;
  readonly final: boolean;
}

export interface LiveSessionView {
  readonly state: "idle" | "connecting" | "live" | "ended" | "error";
  readonly message: string | null;
  readonly rows: readonly TranscriptRow[];
}

const IDLE: LiveSessionView = { state: "idle", message: null, rows: [] };

export function useLiveSession(): LiveSessionView {
  const [view, setView] = useState<LiveSessionView>(IDLE);
  const finals = useRef<TranscriptRow[]>([]);
  const partials = useRef(new Map<string, TranscriptRow>());
  const nextKey = useRef(0);

  useEffect(() => {
    const freshKey = (): string => {
      nextKey.current += 1;
      return `row-${String(nextKey.current)}`;
    };
    const rowsNow = (): TranscriptRow[] =>
      // Sorted rather than concatenated: a partial from one speaker can be
      // OLDER than a final from the other, and bucket order would draw it below.
      [...finals.current, ...partials.current.values()].sort(
        (a, b) => a.tsMs - b.tsMs,
      );
    return window.novaBridge.onLiveEvent((event) => {
      if (event.kind === "status") {
        if (event.state === "connecting") {
          // A new session starts a new transcript.
          finals.current = [];
          partials.current.clear();
        }
        if (event.state === "ended" || event.state === "error") {
          // A partial is a hypothesis the vendor never confirmed; leaving it
          // rendered would present unverified text as the record of the call.
          partials.current.clear();
        }
        setView({
          state: event.state,
          message: event.message ?? null,
          rows: rowsNow(),
        });
        return;
      }
      if (event.kind === "notice") {
        // Advisory (device switched, provider failover): logged, not rendered.
        console.info(`[live] ${event.message}`);
        return;
      }
      const speakerKey = event.speaker ?? "unknown";
      if (event.final) {
        // The final ADOPTS its in-flight partial's key, so committing is the
        // same DOM row easing from hypothesis to record — not a remount that
        // flickers and replays the entrance animation.
        const inFlight = partials.current.get(speakerKey);
        finals.current = [
          ...finals.current,
          {
            key: inFlight?.key ?? freshKey(),
            speaker: event.speaker,
            text: event.text,
            tsMs: event.ts_ms,
            final: true,
          },
        ];
        partials.current.delete(speakerKey);
      } else {
        const existing = partials.current.get(speakerKey);
        partials.current.set(speakerKey, {
          key: existing?.key ?? freshKey(),
          speaker: event.speaker,
          text: event.text,
          tsMs: event.ts_ms,
          final: false,
        });
      }
      setView((current) => ({ ...current, rows: rowsNow() }));
    });
  }, []);

  return view;
}
