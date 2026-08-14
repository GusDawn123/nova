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
  /**
   * The SDK's error class name. Load-bearing rather than decorative: it is the
   * only reliable way to spot a transport failure, because supabase-js reports
   * one with `status: 0` and a message that varies by platform.
   */
  readonly name?: string | undefined;
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
/**
 * supabase-js does NOT throw when the network is down. Its fetch layer raises
 * `AuthRetryableFetchError` — `status: 0` for a dead fetch, the 5xx status for a
 * server error — and `GoTrueClient` then catches it and RETURNS it as `error`
 * because it is an `AuthError`. So an offline sign-in arrives here as a returned
 * value, not as a throw, and without this check it would fall through to
 * `unknown` and tell the user "Something went wrong" when the honest answer is
 * "you are offline".
 *
 * Matched on the class name first because that is the SDK's own signal; the
 * `status === 0` arm covers a plain object that lost its prototype crossing a
 * boundary.
 *
 * Note `=== 0` rather than `(status ?? 0) === 0`. An EXPLICIT zero is what the
 * SDK stamps on a dead fetch; an ABSENT status just means the error never
 * carried one, which is the `unknown` case and not a network claim.
 */
function isRetryableTransportFailure(error: AuthFailure): boolean {
  return error.name === "AuthRetryableFetchError" || error.status === 0;
}

export function classifyAuthError(error: AuthFailure | null): AuthActionResult {
  if (error === null) {
    return { ok: true };
  }
  if (isRetryableTransportFailure(error)) {
    return {
      ok: false,
      kind: "network",
      message: error.message || FALLBACK_NETWORK_MESSAGE,
    };
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
