import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlanWriter } from "../../db/plans.js";
import { buildApp } from "../../app.js";

import type { MeteringLogger } from "./ports.js";
import { createRevenueCatRoutes } from "./revenuecat.js";

/**
 * RevenueCat webhook integration proof (adr-0007 §7; PARITY row 32's billing
 * half) — fixture events against the LIVE local Postgres through the real route
 * + real plan writer: INITIAL_PURCHASE upgrades free→pro (DB-asserted), RENEWAL
 * replays idempotently, EXPIRATION downgrades, and with the env token UNSET the
 * route does not exist at all (404 via buildApp). Self-skips stack-down.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const TOKEN = "integration-webhook-token";
const NOOP_LOGGER: MeteringLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe.skipIf(!hasStack)("RevenueCat webhook (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let userId: string;
  let app: FastifyInstance;

  const fixture = (type: string, over: Record<string, unknown> = {}) => ({
    api_version: "1.0",
    event: {
      id: randomUUID(),
      type,
      app_user_id: userId,
      product_id: "nova_pro_monthly",
      environment: "SANDBOX",
      ...over,
    },
  });

  async function planOf(id: string): Promise<string | undefined> {
    const r = await pool.query<{ plan: string }>(
      "select plan from profiles where id = $1",
      [id],
    );
    return r.rows[0]?.plan;
  }

  function post(payload: unknown, bearer: string | null = TOKEN) {
    return app.inject({
      method: "POST",
      url: "/webhooks/revenuecat",
      ...(bearer === null
        ? {}
        : { headers: { authorization: `Bearer ${bearer}` } }),
      payload: payload as Record<string, unknown>,
    });
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const created = await admin.auth.admin.createUser({
      email: `revenuecat-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user.id;

    app = Fastify({ logger: false });
    void app.register(
      createRevenueCatRoutes({
        token: TOKEN,
        writer: createPlanWriter(pool),
        logger: NOOP_LOGGER,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await admin.auth.admin.deleteUser(userId);
    await pool.end();
  });

  it("[rc-upgrade] fixture INITIAL_PURCHASE upgrades free→pro (DB-asserted)", async () => {
    expect(await planOf(userId)).toBe("free"); // the trigger-provisioned default

    const res = await post(fixture("INITIAL_PURCHASE"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true });
    expect(await planOf(userId)).toBe("pro");
  });

  it("[rc-idempotent] a RENEWAL replay lands the same terminal state, 200 both times", async () => {
    const first = await post(fixture("RENEWAL"));
    const second = await post(fixture("RENEWAL"));
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({ applied: true });
    expect(second.json()).toEqual({ applied: true });
    expect(await planOf(userId)).toBe("pro");
  });

  it("[rc-downgrade] EXPIRATION downgrades pro→free (DB-asserted)", async () => {
    const res = await post(fixture("EXPIRATION"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true });
    expect(await planOf(userId)).toBe("free");
  });

  it("[rc-auth] wrong and missing bearer are 401; the plan is untouched", async () => {
    await post(fixture("INITIAL_PURCHASE")); // → pro
    expect((await post(fixture("EXPIRATION"), "wrong-token")).statusCode).toBe(
      401,
    );
    expect((await post(fixture("EXPIRATION"), null)).statusCode).toBe(401);
    expect(await planOf(userId)).toBe("pro"); // the 401s wrote nothing
  });

  it("[rc-400] a malformed body is a 400", async () => {
    const res = await post({ event: { type: "INITIAL_PURCHASE" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("[rc-unknowns] unknown product and unknown type answer 200 {applied:false}", async () => {
    const product = await post(
      fixture("INITIAL_PURCHASE", { product_id: "mystery_product" }),
    );
    expect(product.statusCode).toBe(200);
    expect(product.json()).toEqual({ applied: false });

    const type = await post(fixture("SOME_FUTURE_EVENT"));
    expect(type.statusCode).toBe(200);
    expect(type.json()).toEqual({ applied: false });

    expect(await planOf(userId)).toBe("pro"); // untouched by either
  });

  it("[rc-deleted] a replay for a deleted account is 200 {applied:false}", async () => {
    const ghost = fixture("RENEWAL", { app_user_id: randomUUID() });
    const res = await post(ghost);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: false });
  });

  it("[rc-absent] with REVENUECAT_WEBHOOK_TOKEN unset the route does not exist", async () => {
    // The test environment never sets the token, so the REAL app wiring must
    // leave the route unregistered entirely.
    expect(process.env.REVENUECAT_WEBHOOK_TOKEN).toBeUndefined();
    const realApp = buildApp({ logger: false });
    const res = await realApp.inject({
      method: "POST",
      url: "/webhooks/revenuecat",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: fixture("INITIAL_PURCHASE"),
    });
    expect(res.statusCode).toBe(404);
    await realApp.close();
  });

  it("[rc-wired] with the env token set the REAL app wiring registers the route", async () => {
    process.env.REVENUECAT_WEBHOOK_TOKEN = TOKEN;
    try {
      const realApp = buildApp({ logger: false });
      // Wrong bearer proves the route EXISTS (401 from the webhook, not 404)…
      const wrongBearer = await realApp.inject({
        method: "POST",
        url: "/webhooks/revenuecat",
        headers: { authorization: "Bearer wrong" },
        payload: fixture("INITIAL_PURCHASE"),
      });
      expect(wrongBearer.statusCode).toBe(401);
      // …and the right bearer applies through the real pool-backed writer.
      const applied = await realApp.inject({
        method: "POST",
        url: "/webhooks/revenuecat",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: fixture("EXPIRATION"),
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toEqual({ applied: true });
      expect(await planOf(userId)).toBe("free");
      await realApp.close();
    } finally {
      delete process.env.REVENUECAT_WEBHOOK_TOKEN;
    }
  });
});
