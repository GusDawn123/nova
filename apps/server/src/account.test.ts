import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";

/**
 * HTTP-level guard tests for `DELETE /account` through `app.inject()` (no network,
 * no Supabase stack). These cover the decisions `requireAuth` makes BEFORE the
 * handler runs: the uniform 401 for a missing token and the 503 for an
 * unconfigured server. The happy path (202 + queue side effects, which need a
 * real token and a live DB) is proven by account.integration.test.ts.
 */

// Any syntactically valid URL works — every test here is answered before the
// JWKS at this URL would be fetched.
const DUMMY_URL = "http://127.0.0.1:54321";

describe("DELETE /account (requireAuth guard)", () => {
  describe("with SUPABASE_URL configured", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", DUMMY_URL);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns a uniform 401 when no Authorization header is present", async () => {
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: "DELETE",
          url: "/account",
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
          method: "DELETE",
          url: "/account",
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
