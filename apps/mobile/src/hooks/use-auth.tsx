import type { AuthError, Session } from '@supabase/supabase-js';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { supabase, supabaseConfigError } from '@/lib/supabase';

/**
 * Smart auth layer: subscribes to Supabase's `onAuthStateChange` (no polling)
 * and exposes the session as a discriminated union so screens render exactly
 * one branch and never an ambiguous in-between. Actions surface a typed result
 * (bad credentials vs network vs unknown) rather than throwing, so the dumb
 * screens can decide what to show.
 */
export type AuthState =
  | { status: 'loading' }
  // Env missing/invalid — `lib/supabase` returned no client. Distinct from
  // signed-out so screens can explain the misconfig instead of prompting a
  // sign-in that could never succeed.
  | { status: 'unavailable'; message: string }
  | { status: 'signed-out' }
  | { status: 'signed-in'; session: Session };

/** Why an auth action failed. Discriminated so callers branch, not string-match. */
export type AuthErrorKind = 'invalid-credentials' | 'network' | 'unavailable' | 'unknown';

export type AuthActionResult =
  | { ok: true }
  | { ok: false; kind: AuthErrorKind; message: string };

interface AuthActions {
  signUp: (email: string, password: string) => Promise<AuthActionResult>;
  signIn: (email: string, password: string) => Promise<AuthActionResult>;
  signOut: () => Promise<void>;
  // SEAM: OAuth providers (Apple, Google) are deferred until Gustavo's Apple
  // Developer + Google OAuth credentials exist. When they do, add
  // `signInWithApple` / `signInWithGoogle` here and wire them through
  // `lib/supabase` — no other shape change is required.
}

export type UseAuth = AuthState & AuthActions;

const AuthContext = createContext<UseAuth | null>(null);

/** Map a Supabase auth error (or a thrown network failure) to our typed kind. */
function classifyError(error: AuthError | null, thrown?: unknown): AuthActionResult {
  if (error === null && thrown === undefined) {
    return { ok: true };
  }
  // A thrown value (not an AuthError) is almost always the fetch failing.
  if (thrown !== undefined) {
    const message = thrown instanceof Error ? thrown.message : 'Network request failed';
    return { ok: false, kind: 'network', message };
  }
  // AuthError present. Supabase returns 400 "Invalid login credentials" for a
  // wrong email/password; treat that (and other 4xx auth rejections) as a
  // credentials problem, anything else as unknown.
  const status = error?.status ?? 0;
  if (status === 400 || status === 401 || status === 422) {
    return { ok: false, kind: 'invalid-credentials', message: error?.message ?? 'Invalid credentials' };
  }
  return { ok: false, kind: 'unknown', message: error?.message ?? 'Something went wrong' };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    supabase === null
      ? { status: 'unavailable', message: supabaseConfigError ?? 'Auth unavailable' }
      : { status: 'loading' },
  );

  useEffect(() => {
    if (supabase === null) {
      return;
    }
    // onAuthStateChange fires an initial event with the restored session (or
    // null) right after subscribing, which resolves the `loading` state and
    // covers persistence-across-restart. We only setState in the callback —
    // never call back into supabase here (that can deadlock the client).
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(
        session === null ? { status: 'signed-out' } : { status: 'signed-in', session },
      );
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, []);

  const actions = useMemo<AuthActions>(() => {
    async function signUp(email: string, password: string): Promise<AuthActionResult> {
      if (supabase === null) {
        return { ok: false, kind: 'unavailable', message: supabaseConfigError ?? 'Auth unavailable' };
      }
      try {
        const { error } = await supabase.auth.signUp({ email, password });
        return classifyError(error);
      } catch (thrown) {
        return classifyError(null, thrown);
      }
    }

    async function signIn(email: string, password: string): Promise<AuthActionResult> {
      if (supabase === null) {
        return { ok: false, kind: 'unavailable', message: supabaseConfigError ?? 'Auth unavailable' };
      }
      try {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return classifyError(error);
      } catch (thrown) {
        return classifyError(null, thrown);
      }
    }

    async function signOut(): Promise<void> {
      if (supabase === null) {
        return;
      }
      await supabase.auth.signOut();
    }

    return { signUp, signIn, signOut };
  }, []);

  const value = useMemo<UseAuth>(() => ({ ...state, ...actions }), [state, actions]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Consume the auth layer. Throws if used outside `AuthProvider` (a wiring bug). */
export function useAuth(): UseAuth {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return value;
}
