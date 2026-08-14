import { useEffect, useState } from "react";

import type { AuthState } from "../../main/auth/state";

/**
 * The renderer's view of auth, which is entirely a mirror: the main process owns
 * the session and pushes every change here. Two sources feed it and they can
 * arrive in either order —
 *
 *   ASK   `getAuthState()` on mount, because a renderer that reloads (or opens
 *         second) has missed every push that came before it.
 *   PUSH  `onAuthStateChange`, because a token refresh or a restored session
 *         happens on Supabase's schedule and no click will ever ask for it.
 *
 * The `pushed` flag is the whole subtlety. A push that lands while the initial
 * ask is still in flight is NEWER than the answer that ask will return, so the
 * ask must not be allowed to overwrite it — otherwise a session restored during
 * startup flickers back to signed-out for one render.
 */
export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let pushed = false;

    const unsubscribe = window.novaBridge.onAuthStateChange((next) => {
      pushed = true;
      if (!cancelled) {
        setState(next);
      }
    });

    async function ask(): Promise<void> {
      const initial = await window.novaBridge.getAuthState();
      if (!cancelled && !pushed) {
        setState(initial);
      }
    }

    void ask();

    // Runs on unmount AND on every StrictMode double-invoke in dev, which is
    // exactly why the bridge hands back an unsubscribe rather than assuming one
    // listener per channel forever.
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
