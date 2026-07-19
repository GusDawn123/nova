import type { FastifyReply, FastifyRequest } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";

import {
  type AuthUser,
  createSupabaseJwks,
  verifyAccessToken,
} from "../auth/verify-token.js";

/**
 * Auth preHandler wiring, kept in one place alongside the other Fastify hooks
 * (mirrors `plugins/request-id.ts`). A route opts in with
 * `{ preHandler: requireAuth }`; on success `request.user` is populated, on any
 * token failure the request is answered with a uniform 401.
 */

// Make `request.user` visible to every handler downstream of `requireAuth`.
// It is optional because only auth-guarded routes populate it.
declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** Uniform auth-failure body — no signal about WHY the token was rejected. */
const UNAUTHORIZED = { error: "unauthorized" } as const;

/**
 * Body returned when the server itself cannot verify tokens (SUPABASE_URL
 * unset, so there is no JWKS to check against). Distinct from 401 on purpose —
 * see requireAuth.
 */
const UNAVAILABLE = { error: "unavailable" } as const;

/**
 * The Supabase URL, read lazily from the environment (same posture as the db
 * adapter: optional at boot so /health serves without it, demanded only on
 * auth-guarded paths). Returns `undefined` when absent/invalid.
 */
const supabaseUrlSchema = z.string().url();

function readSupabaseUrl(): string | undefined {
  const result = supabaseUrlSchema.safeParse(process.env.SUPABASE_URL);
  return result.success ? result.data : undefined;
}

/**
 * One remote-JWKS resolver per URL. The resolver caches keys internally, so it
 * must be built once and reused — rebuilding per request would refetch the JWKS
 * every time. Keyed by URL so a config change (or tests) gets a fresh resolver.
 */
const jwksByUrl = new Map<string, JWTVerifyGetKey>();

function jwksFor(url: string): JWTVerifyGetKey {
  let jwks = jwksByUrl.get(url);
  if (jwks === undefined) {
    jwks = createSupabaseJwks(url);
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

/**
 * Pull the token out of an `Authorization: Bearer <token>` header. Anything that
 * is not exactly that scheme (missing header, `Basic ...`, garbage, empty token)
 * yields `undefined` and is treated as an auth failure by the caller.
 */
export function extractBearerToken(
  header: string | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

/**
 * Fastify preHandler enforcing a valid Supabase access token.
 *
 * - SUPABASE_URL unset -> 503 `{ error: "unavailable" }` (server misconfig, not
 *   a client fault; a 401 here would falsely blame a correct caller's
 *   credentials and mask a broken deploy). See report for the full rationale.
 * - no/invalid token   -> 401 `{ error: "unauthorized" }` (uniform, detail-free).
 * - valid token        -> decorate `request.user` and fall through.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const url = readSupabaseUrl();
  if (url === undefined) {
    await reply.code(503).send(UNAVAILABLE);
    return;
  }

  const token = extractBearerToken(request.headers.authorization);
  if (token === undefined) {
    await reply.code(401).send(UNAUTHORIZED);
    return;
  }

  const result = await verifyAccessToken(token, jwksFor(url));
  if (!result.valid) {
    await reply.code(401).send(UNAUTHORIZED);
    return;
  }

  request.user = result.user;
}
