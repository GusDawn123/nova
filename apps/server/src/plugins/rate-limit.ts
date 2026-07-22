import { createHash } from "node:crypto";

import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { extractBearerToken } from "./auth.js";

/**
 * REST-surface rate limiting (Phase 6, adr-0007 §6) — @fastify/rate-limit,
 * boring and battle-tested, registered globally in `buildApp` BEFORE any route
 * so every REST endpoint inherits it. The live WS route opts out via
 * `config: { rateLimit: false }` (it has the one-session-per-user concurrency
 * cap instead — adr-0007 §6).
 *
 * KEYING (documented deviation from the plan's "user id post-auth"): the
 * limiter runs at `onRequest` — before the route-level `requireAuth`
 * preHandler, so `request.user` cannot exist yet, and re-verifying the JWT in
 * the key generator would double the auth work on every request. Instead the
 * key is a sha-256 HASH of the bearer token when one is present (the caller's
 * stable credential — one bucket per user session in practice; hashing keeps
 * the raw token out of limiter state/memory dumps), falling back to the client
 * IP for pre-auth traffic. Limiting BEFORE verification also means the limiter
 * protects the auth path itself from hammering.
 */

/** Tunables — zod-defaulted + injectable (RULES: no magic numbers). */
export const rateLimitConfigSchema = z
  .object({
    /** Requests allowed per caller per window (default 100/min). */
    max: z.number().int().positive().default(100),
    /** Window length in ms. */
    windowMs: z.number().int().positive().default(60_000),
  })
  .strict();

export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;

/** One bucket per caller: token hash when present, client IP otherwise. */
function callerKey(req: FastifyRequest): string {
  const token = extractBearerToken(req.headers.authorization);
  if (token !== undefined) {
    // why hash: the raw token is a secret and must not sit in limiter state.
    const digest = createHash("sha256").update(token).digest("hex");
    return `tok:${digest.slice(0, 32)}`;
  }
  return `ip:${req.ip}`;
}

/**
 * Typed 429 body. The plugin THROWS this value and fastify uses `statusCode`
 * for the reply code while serializing the object as the payload — so the body
 * keeps the house `{ error: ... }` discriminant (plus the code fields).
 */
const RATE_LIMITED = {
  statusCode: 429,
  error: "rate_limited",
  message: "rate limit exceeded, retry later",
} as const;

/** Register the limiter on `app` (await-free caller: fastify defers loading). */
export async function registerRateLimit(
  app: FastifyInstance,
  config: RateLimitConfig,
): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: true,
    max: config.max,
    timeWindow: config.windowMs,
    keyGenerator: callerKey,
    errorResponseBuilder: () => RATE_LIMITED,
    // In-memory store: single-instance posture is the deployment law (same
    // opener as the live session registry — a multi-instance deploy brings a
    // shared store).
  });
}
