import { z } from "zod";

/**
 * How an auth action failed, and the typed result every action returns instead
 * of throwing. Lifted from the mobile app's `hooks/use-auth.tsx` so the two
 * clients classify the same failure the same way — a wrong password is
 * `invalid-credentials` on a phone and on a desktop.
 *
 * The schemas are the source of truth and the types are inferred from them
 * (RULES §10: derive types, never a hand-written twin), because these values
 * cross the IPC boundary and `ipc/contract.ts` builds on them.
 */

/**
 * `invalid-request` is the ONE kind mobile has no use for. It exists because a
 * desktop has an untrusted renderer: `ipc/handlers.ts` parses what the UI sends
 * before it reaches Supabase, and a payload that fails that parse is neither a
 * credentials problem nor a network one.
 */
export const authErrorKindSchema = z.enum([
  "invalid-credentials",
  "invalid-request",
  "network",
  "unavailable",
  "unknown",
]);
export type AuthErrorKind = z.infer<typeof authErrorKindSchema>;

export const authActionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    kind: authErrorKindSchema,
    message: z.string(),
  }),
]);
export type AuthActionResult = z.infer<typeof authActionResultSchema>;

/**
 * The part of a Supabase `AuthError` this classification actually reads.
 * Structural rather than the SDK's class so the mapping can be tested without
 * loading `@supabase/supabase-js`, and so this module stays outside the one-seam
 * rule in `auth/supabase.ts`. `status?: number | undefined` (not `status?:
 * number`) because `exactOptionalPropertyTypes` otherwise rejects the SDK's own
 * `status: number | undefined` field.
 */
export interface AuthFailure {
  readonly status?: number | undefined;
  readonly message: string;
}

const FALLBACK_CREDENTIALS_MESSAGE = "Invalid credentials";
const FALLBACK_UNKNOWN_MESSAGE = "Something went wrong";
const FALLBACK_NETWORK_MESSAGE = "Network request failed";

/**
 * A Supabase-reported failure, or `null` for success.
 *
 * Supabase answers a wrong email/password with 400 "Invalid login credentials",
 * and a rejected sign-up with 422; both are the user's input, not a fault. Any
 * other status is `unknown` — which is honest, and keeps a 500 from being
 * reported to the user as a typo.
 */
export function classifyAuthError(error: AuthFailure | null): AuthActionResult {
  if (error === null) {
    return { ok: true };
  }
  const status = error.status ?? 0;
  if (status === 400 || status === 401 || status === 422) {
    return {
      ok: false,
      kind: "invalid-credentials",
      message: error.message || FALLBACK_CREDENTIALS_MESSAGE,
    };
  }
  return {
    ok: false,
    kind: "unknown",
    message: error.message || FALLBACK_UNKNOWN_MESSAGE,
  };
}

/**
 * A value that was THROWN rather than returned. supabase-js only throws here
 * when the underlying fetch died, so this is the offline/unreachable case.
 */
export function classifyThrown(thrown: unknown): AuthActionResult {
  const message =
    thrown instanceof Error && thrown.message !== ""
      ? thrown.message
      : FALLBACK_NETWORK_MESSAGE;
  return { ok: false, kind: "network", message };
}

/** No Supabase client at all — bad or absent config, not a failed attempt. */
export function unavailableResult(message: string): AuthActionResult {
  return { ok: false, kind: "unavailable", message };
}
