import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

/**
 * Token verification boundary.
 *
 * This is the ONLY module that knows HOW a Supabase access token is validated.
 * Supabase (CLI >= 2.1x, and hosted projects on the new signing keys) issues
 * user access tokens signed with an asymmetric ES256 key and publishes the
 * matching PUBLIC keys as a JWKS. We verify against that JWKS — the server never
 * holds a signing secret. A future change (e.g. an extra alg, key rotation
 * policy, or a legacy HS256 fallback) should touch only this file; callers
 * depend on the narrow {@link verifyAccessToken} contract, not on `jose`.
 */

/** The identity we resolve from a valid token. Kept minimal (YAGNI). */
export interface AuthUser {
  id: string;
  email?: string;
}

/**
 * Why a token was rejected. Callers collapse every one of these into a single
 * uniform 401 at the HTTP boundary — the distinction exists for tests and logs,
 * never to leak back to the caller.
 */
export type VerifyFailureReason =
  "malformed" | "expired" | "invalid-signature" | "invalid-payload";

/** Discriminated result — no boolean-flag-plus-optional-field ambiguity. */
export type VerifyAccessTokenResult =
  | { valid: true; user: AuthUser }
  | { valid: false; reason: VerifyFailureReason };

/**
 * Claims we require from the payload. Supabase issues far more, but the server
 * only trusts `sub` (the user uuid) and opportunistically surfaces `email`.
 * jose enforces `exp`; an unexpected shape here is a rejection, never a crash.
 */
const payloadSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email().optional(),
});

/** Where a Supabase project publishes its ES256 signing (public) keys. */
export function supabaseJwksUrl(supabaseUrl: string): URL {
  return new URL("/auth/v1/.well-known/jwks.json", supabaseUrl);
}

/**
 * Build a key resolver backed by the project's remote JWKS. The returned
 * function caches keys internally and only refetches on an unknown `kid`, so
 * steady-state verification does no network round trip. Create it ONCE per URL
 * (see plugins/auth.ts) — rebuilding it per request would defeat that cache.
 */
export function createSupabaseJwks(supabaseUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(supabaseJwksUrl(supabaseUrl));
}

/**
 * Verify a Supabase access token using `getKey` (typically a JWKS resolver).
 * Pure w.r.t. app state: every outcome — good token or any failure — is a
 * returned value, so the HTTP layer maps all failures to one 401 without
 * try/catch of its own.
 */
export async function verifyAccessToken(
  token: string,
  getKey: JWTVerifyGetKey,
): Promise<VerifyAccessTokenResult> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      // Pin the alg (blocks alg-confusion) and the audience Supabase stamps on
      // every user access token; require `exp` so a signature-valid token
      // WITHOUT an expiry is rejected rather than treated as eternal.
      // `iss` validation is consciously skipped: the JWKS we verify against is
      // already scoped to our own SUPABASE_URL, so a token signed by anyone
      // else fails the signature check before issuer would matter.
      algorithms: ["ES256"],
      audience: "authenticated",
      requiredClaims: ["exp"],
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { valid: false, reason: "expired" };
    }
    if (error instanceof errors.JWTClaimValidationFailed) {
      // Wrong/missing aud, missing exp, etc. — structurally a bad payload.
      return { valid: false, reason: "invalid-payload" };
    }
    if (
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JWKSNoMatchingKey
    ) {
      return { valid: false, reason: "invalid-signature" };
    }
    // JWTInvalid, JWSInvalid, JOSEAlgNotAllowed, fetch failures, etc.
    return { valid: false, reason: "malformed" };
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { valid: false, reason: "invalid-payload" };
  }

  const user: AuthUser =
    parsed.data.email !== undefined
      ? { id: parsed.data.sub, email: parsed.data.email }
      : { id: parsed.data.sub };
  return { valid: true, user };
}
