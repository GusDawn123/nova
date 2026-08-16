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

  useEffect(() => {
    const rowsNow = (): TranscriptRow[] => [
      ...finals.current,
      ...partials.current.values(),
    ];
    return window.novaBridge.onLiveEvent((event) => {
      if (event.kind === "status") {
        if (event.state === "connecting") {
          // A new session starts a new transcript.
          finals.current = [];
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
        finals.current = [
          ...finals.current,
          {
            key: `final-${String(finals.current.length)}`,
            speaker: event.speaker,
            text: event.text,
            tsMs: event.ts_ms,
            final: true,
          },
        ];
        partials.current.delete(speakerKey);
      } else {
        partials.current.set(speakerKey, {
          key: `partial-${speakerKey}`,
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
