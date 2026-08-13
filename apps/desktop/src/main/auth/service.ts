import type { Credentials } from "../ipc/contract";
import {
  classifyAuthError,
  classifyThrown,
  unavailableResult,
  type AuthActionResult,
} from "./errors";
import { projectAuthState, type AuthState } from "./state";
import { createSupabaseSeam, type SupabaseSeam } from "./supabase";

/**
 * The auth layer for the main process.
 *
 * Shaped after the mobile app's `hooks/use-auth.tsx` — the same discriminated
 * state, the same typed results that never throw — with React removed and one
 * deliberate difference: the Supabase `Session` stays HERE. Callers get an
 * identity; the access token is handed only to the api client, and the refresh
 * token never leaves this module.
 *
 * The classification and projection live in `errors.ts` and `state.ts` as pure
 * functions so they can be tested without loading Electron or the vendor SDK.
 * What is left here is the part that genuinely needs both: subscription
 * lifetime, and holding the current session.
 */
export interface AuthService {
  getState(): AuthState;
  /** Returns an unsubscribe function. */
  subscribe(listener: (state: AuthState) => void): () => void;
  signIn(credentials: Credentials): Promise<AuthActionResult>;
  signUp(credentials: Credentials): Promise<AuthActionResult>;
  signOut(): Promise<AuthActionResult>;
  /**
   * The access token for the api client. Async because supabase-js refreshes an
   * expired token on demand, and the caller wants the answer after that has
   * happened rather than the stale one before it.
   */
  getAccessToken(): Promise<string | null>;
  dispose(): void;
}

export function createAuthService(
  seam: SupabaseSeam = createSupabaseSeam(),
): AuthService {
  const client = seam.client;
  const listeners = new Set<(state: AuthState) => void>();
  const configError = seam.configError ?? "Sign-in is unavailable.";

  let state: AuthState =
    client === null
      ? { status: "unavailable", message: configError }
      : { status: "loading" };

  function emit(next: AuthState): void {
    state = next;
    for (const listener of listeners) {
      // Isolated per listener. `emit` runs inside supabase-js's own
      // `onAuthStateChange` callback, so an unguarded throw would skip every
      // remaining subscriber AND unwind into the SDK — which would mean one
      // broken window handler could stop the IPC broadcast that every other
      // window depends on.
      try {
        listener(next);
      } catch (error: unknown) {
        console.error("[auth] a state listener threw", error);
      }
    }
  }

  let unsubscribeFromSupabase: (() => void) | null = null;

  if (client !== null) {
    // onAuthStateChange fires an initial event carrying the restored session
    // (or null) right after subscribing. That is what resolves `loading` and
    // what covers persistence across restarts, so there is no separate
    // getSession call and no polling. Only assign state in here — calling back
    // into supabase from this callback can deadlock the client.
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      emit(projectAuthState(nextSession));
    });
    unsubscribeFromSupabase = (): void => {
      data.subscription.unsubscribe();
    };
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async signIn(credentials) {
      if (client === null) {
        return unavailableResult(configError);
      }
      try {
        const { error } = await client.auth.signInWithPassword(credentials);
        return classifyAuthError(error);
      } catch (thrown: unknown) {
        return classifyThrown(thrown);
      }
    },

    async signUp(credentials) {
      if (client === null) {
        return unavailableResult(configError);
      }
      try {
        const { error } = await client.auth.signUp(credentials);
        return classifyAuthError(error);
      } catch (thrown: unknown) {
        return classifyThrown(thrown);
      }
    },

    async signOut() {
      if (client === null) {
        return unavailableResult(configError);
      }
      try {
        const { error } = await client.auth.signOut();
        return classifyAuthError(error);
      } catch (thrown: unknown) {
        return classifyThrown(thrown);
      }
    },

    async getAccessToken() {
      if (client === null) {
        return null;
      }
      // Ask the SDK rather than reading the cached session: this is the call
      // that refreshes an expired token, and the api client's whole reason for
      // taking a function instead of a string is to get the refreshed one.
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    },

    dispose() {
      unsubscribeFromSupabase?.();
      listeners.clear();
    },
  };
}
