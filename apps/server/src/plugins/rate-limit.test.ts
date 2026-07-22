import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

/**
 * [rate-limit] REST-surface rate limiting (Phase 6, adr-0007 §6):
 * @fastify/rate-limit, keyed per-caller (bearer-token hash when present — the
 * caller's stable credential, one bucket per user in practice — else the client
 * IP pre-auth), config-tunable, typed 429 body in the house `{ error }` shape.
 * The live WS route is EXCLUDED (it has the one-session-per-user concurrency cap
 * instead). The suite injects with a tiny max so the window math is instant.
 */

const TINY = { max: 3, windowMs: 60_000 };

describe("REST rate limiting", () => {
  it("[rate-limit] the same caller is 429'd past max with the typed body", async () => {
    const app = buildApp({ logger: false, rateLimit: TINY });

    for (let i = 0; i < TINY.max; i++) {
      const ok = await app.inject({ method: "GET", url: "/health" });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/health" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "rate_limited" });

    await app.close();
  });

  it("[rate-limit] rapid-fire past max → 429s begin, another caller stays healthy", async () => {
    const app = buildApp({ logger: false, rateLimit: { max: 10 } });

    // 100 rapid requests from one caller: the first 10 pass, the rest 429.
    const results: number[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer caller-one-token" },
      });
      results.push(res.statusCode);
    }
    expect(results.filter((s) => s === 200)).toHaveLength(10);
    expect(results.filter((s) => s === 429)).toHaveLength(90);

    // The server is healthy after: a DIFFERENT caller (another token bucket)
    // gets a normal 200 immediately.
    const other = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer caller-two-token" },
    });
    expect(other.statusCode).toBe(200);

    await app.close();
  });

  it("[rate-limit] authed (token) and anonymous (ip) callers get separate buckets", async () => {
    const app = buildApp({ logger: false, rateLimit: TINY });

    // Exhaust the anonymous (ip-keyed) bucket …
    for (let i = 0; i < TINY.max; i++) {
      await app.inject({ method: "GET", url: "/health" });
    }
    const anonLimited = await app.inject({ method: "GET", url: "/health" });
    expect(anonLimited.statusCode).toBe(429);

    // … while a bearer-carrying caller (token-keyed bucket) still passes.
    const authed = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer some-user-token" },
    });
    expect(authed.statusCode).toBe(200);

    await app.close();
  });

  it("[rate-limit] the live WS route is excluded (concurrency-capped instead)", async () => {
    const app = buildApp({ logger: false, rateLimit: TINY });

    // Exhaust the anonymous bucket on the REST surface.
    for (let i = 0; i <= TINY.max; i++) {
      await app.inject({ method: "GET", url: "/health" });
    }
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(429);

    // The same (ip-keyed) caller hitting /live is NOT answered by the limiter:
    // a plain HTTP GET on the WS route fails the upgrade handshake (4xx from the
    // websocket layer), never the limiter's 429.
    const live = await app.inject({ method: "GET", url: "/live" });
    expect(live.statusCode).not.toBe(429);

    await app.close();
  });
});
