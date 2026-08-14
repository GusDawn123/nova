import { useCallback, useEffect, useState } from "react";
import type { MeResponse } from "@nova/shared";

/**
 * `GET /me`, asked for over the bridge. The request itself happens in the main
 * process — see `main/api/client.ts` for why — so there is no fetch, no token
 * and no timeout here; this hook owns only the three things the screen renders.
 *
 * A discriminated union rather than a `data`/`error`/`loading` triple, so the
 * screen renders exactly one branch and cannot paint a half-state (RULES §10).
 */
export type MeState =
  | { status: "loading" }
  | { status: "success"; data: MeResponse }
  | { status: "error"; message: string };

export interface UseMe {
  readonly state: MeState;
  /** Ask again. The typed failures are all things a second attempt might fix. */
  readonly reload: () => void;
}

export function useMe(): UseMe {
  const [state, setState] = useState<MeState>({ status: "loading" });
  /** A counter, not a boolean: two reloads in a row must both take effect. */
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    async function load(): Promise<void> {
      const result = await window.novaBridge.getMe();
      if (cancelled) {
        return;
      }
      // Every failure the main process can produce already carries a sentence
      // written for a person (`main/api/client.ts`). The renderer's job is to
      // show it, not to invent a second vocabulary for the same failures.
      setState(
        result.ok
          ? { status: "success", data: result.data }
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
