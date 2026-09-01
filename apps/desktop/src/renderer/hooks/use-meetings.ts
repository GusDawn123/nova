import { useCallback, useEffect, useState } from "react";
import type { MeetingListItem } from "@nova/shared";

/**
 * The meetings list, loaded through the bridge whenever the history view
 * opens. Same three-state shape as `use-me`: the failure sentence comes from
 * main (`main/api/client.ts`) already written for a person, so the renderer
 * shows it instead of inventing a second vocabulary for the same failures.
 */
export type MeetingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; meetings: readonly MeetingListItem[] };

export interface UseMeetings {
  state: MeetingsState;
  reload: () => void;
}

export function useMeetings(): UseMeetings {
  const [state, setState] = useState<MeetingsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const result = await window.novaBridge.listMeetings();
      if (cancelled) {
        return;
      }
      setState(
        result.ok
          ? { status: "success", meetings: result.data.meetings }
          : { status: "error", message: result.message },
      );
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { state, reload };
}
