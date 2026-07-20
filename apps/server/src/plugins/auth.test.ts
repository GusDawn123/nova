import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";

/**
 * HTTP-level auth tests through the protected `GET /me` route (`app.inject()`,
 * no network, no Supabase stack). These cover the decisions `requireAuth` makes
 * BEFORE it ever reaches the JWKS: the uniform-401 header failures and the 503
 * unconfigured case. The valid-token -> 200 path (which needs a real JWKS/ES256
 * key) is proven end to end by me.integration.test.ts against the live stack,
 * and the crypto-rejection paths by verify-token.test.ts.
 */

// Any syntactically valid URL works here — every test in this group is answered
// before the JWKS at this URL would be fetched.
const DUMMY_URL = "http://127.0.0.1:54321";

describe("GET /me (requireAuth)", () => {
  describe("with SUPABASE_URL configured", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", DUMMY_URL);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ["no Authorization header", {}],
      ["a non-Bearer scheme", { authorization: "Basic x" }],
      ["a garbage header", { authorization: "not-a-real-header" }],
      ["an empty Bearer token", { authorization: "Bearer " }],
    ])("returns a uniform 401 for %s", async (_label, headers) => {
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: "GET",
          url: "/me",
          headers,
        });

        expect(response.statusCode).toBe(401);
        expect(response.json<unknown>()).toEqual({ error: "unauthorized" });
      } finally {
        await app.close();
      }
    });
  });

  describe("without SUPABASE_URL", () => {
    beforeEach(() => {
      // Ensure it is unset even if the ambient shell / .env provided one.
      vi.stubEnv("SUPABASE_URL", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns 503 (server not configured) even with a Bearer token present", async () => {
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: "Bearer some.jwt.token" },
        });

        expect(response.statusCode).toBe(503);
        expect(response.json<unknown>()).toEqual({ error: "unavailable" });
      } finally {
        await app.close();
      }
    });
  });
});
