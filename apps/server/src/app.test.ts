import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "@nova/shared";

import { buildApp } from "./app.js";
import { version } from "./version.js";

describe("GET /health", () => {
  it("returns 200 with a body matching healthResponseSchema", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      const parsed = healthResponseSchema.parse(response.json<unknown>());
      expect(parsed.ok).toBe(true);
      expect(parsed.version).toBe(version);
    } finally {
      await app.close();
    }
  });

  it("echoes a provided x-request-id header", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { "x-request-id": "test-req-123" },
      });

      expect(response.headers["x-request-id"]).toBe("test-req-123");
    } finally {
      await app.close();
    }
  });

  it("generates an x-request-id when none is provided", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      const requestId = response.headers["x-request-id"];
      expect(typeof requestId).toBe("string");
      expect(requestId).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

describe("route registration on a partially-configured boot", () => {
  /**
   * Run `fn` with the supabase-js seam configured and SUPABASE_DB_URL absent —
   * the exact gap this suite is about. Env is restored whatever happens.
   */
  async function withSupabaseButNoDbUrl(
    fn: () => Promise<void>,
  ): Promise<void> {
    const saved = {
      url: process.env.SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
      dbUrl: process.env.SUPABASE_DB_URL,
    };
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-gating-only";
    delete process.env.SUPABASE_DB_URL;
    try {
      await fn();
    } finally {
      if (saved.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
      if (saved.dbUrl === undefined) delete process.env.SUPABASE_DB_URL;
      else process.env.SUPABASE_DB_URL = saved.dbUrl;
    }
  }

  it("mounts the notes routes without SUPABASE_DB_URL (401, not 404)", async () => {
    // why: the notes surface used to require the pg pool as well, so this exact
    // env — supabase-js configured, no DB url — mounted the meetings LIST but not
    // the notes GET. The mobile screen renders that 404 as "this meeting is no
    // longer available": a config gap wearing a deleted-data message.
    //
    // 401 (requireAuth ran) is the tell that the route EXISTS; the pool-backed
    // extras degrade behind it (completed_item_ids []).
    await withSupabaseButNoDbUrl(async () => {
      const app = buildApp({ logger: false });
      try {
        const meetingId = randomUUID();
        for (const target of [
          { method: "GET" as const, url: `/meetings/${meetingId}/notes` },
          { method: "GET" as const, url: "/meetings" },
          {
            method: "PUT" as const,
            url: `/meetings/${meetingId}/notes/items/a1`,
          },
        ]) {
          const res = await app.inject(target);
          expect({ url: target.url, code: res.statusCode }).toEqual({
            url: target.url,
            code: 401,
          });
        }
      } finally {
        await app.close();
      }
    });
  });
});
