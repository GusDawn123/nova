import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { meteringConfigSchema } from "./config.js";
import type { MeteringLogger } from "./ports.js";
import {
  createRevenueCatHandler,
  createRevenueCatRoutes,
  revenueCatEnvelopeSchema,
  type PlanWriter,
} from "./revenuecat.js";

/**
 * RevenueCat webhook unit tests (adr-0007 §7): the zod envelope (a HOSTILE
 * vendor boundary — RULES §1 lists vendor webhook payloads explicitly), the
 * event→plan mapping, the product→plan config map, and the token-gated route.
 * Every vendor surprise (unknown type, unknown product, anonymous app_user_id,
 * replay for a deleted account) answers 200 {applied:false} + a warn — never a
 * 500 on someone else's new event type.
 */

const USER_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "test-webhook-token";

function spyLogger() {
  const warn = vi.fn();
  const info = vi.fn();
  const logger: MeteringLogger = { info, warn, error: vi.fn() };
  return { logger, warn, info };
}

function fakeWriter(result: "applied" | "user_missing" = "applied") {
  const calls: { userId: string; plan: string }[] = [];
  const writer: PlanWriter = {
    setPlan(userId, plan) {
      calls.push({ userId, plan });
      return Promise.resolve(result);
    },
  };
  return { writer, calls };
}

const config = meteringConfigSchema.parse({});

const event = (
  type: string,
  over: { app_user_id?: string; product_id?: string } = {},
) => ({
  type,
  app_user_id: over.app_user_id ?? USER_ID,
  product_id: over.product_id ?? "nova_pro_monthly",
});

describe("revenueCatEnvelopeSchema", () => {
  it("parses the documented envelope and ignores unknown keys", () => {
    const parsed = revenueCatEnvelopeSchema.safeParse({
      api_version: "1.0",
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: USER_ID,
        product_id: "nova_pro_monthly",
        id: "evt_1",
        environment: "SANDBOX",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a structurally malformed body", () => {
    expect(revenueCatEnvelopeSchema.safeParse({}).success).toBe(false);
    expect(
      revenueCatEnvelopeSchema.safeParse({ event: { type: "X" } }).success,
    ).toBe(false);
    expect(revenueCatEnvelopeSchema.safeParse("not json").success).toBe(false);
  });
});

describe("createRevenueCatHandler — event→plan mapping", () => {
  it.each(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION"])(
    "%s with a mapped product applies pro",
    async (type) => {
      const { logger } = spyLogger();
      const { writer, calls } = fakeWriter();
      const apply = createRevenueCatHandler({ writer, config, logger });
      await expect(apply(event(type))).resolves.toEqual({ applied: true });
      expect(calls).toEqual([{ userId: USER_ID, plan: "pro" }]);
    },
  );

  it("EXPIRATION of a mapped product downgrades to free", async () => {
    const { logger } = spyLogger();
    const { writer, calls } = fakeWriter();
    const apply = createRevenueCatHandler({ writer, config, logger });
    await expect(apply(event("EXPIRATION"))).resolves.toEqual({
      applied: true,
    });
    expect(calls).toEqual([{ userId: USER_ID, plan: "free" }]);
  });

  it("CANCELLATION alone is a known no-op (access runs to period end)", async () => {
    const { logger, warn } = spyLogger();
    const { writer, calls } = fakeWriter();
    const apply = createRevenueCatHandler({ writer, config, logger });
    await expect(apply(event("CANCELLATION"))).resolves.toEqual({
      applied: false,
    });
    expect(calls).toEqual([]);
    // Known-but-no-op vendor traffic is expected → no warn.
    expect(warn).not.toHaveBeenCalled();
  });

  it("an UNKNOWN event type → applied:false + one warn (never a throw)", async () => {
    const { logger, warn } = spyLogger();
    const { writer, calls } = fakeWriter();
    const apply = createRevenueCatHandler({ writer, config, logger });
    await expect(apply(event("SOME_FUTURE_EVENT"))).resolves.toEqual({
      applied: false,
    });
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an unknown product → applied:false + one warn", async () => {
    const { logger, warn } = spyLogger();
    const { writer, calls } = fakeWriter();
    const apply = createRevenueCatHandler({ writer, config, logger });
    await expect(
      apply(event("INITIAL_PURCHASE", { product_id: "mystery_product" })),
    ).resolves.toEqual({ applied: false });
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a non-uuid app_user_id (RevenueCat anonymous id) → applied:false + warn", async () => {
    const { logger, warn } = spyLogger();
    const { writer, calls } = fakeWriter();
    const apply = createRevenueCatHandler({ writer, config, logger });
    await expect(
      apply(
        event("INITIAL_PURCHASE", {
          app_user_id: "$RCAnonymousID:87c6049c58069238dce29853f60b1746",
        }),
      ),
    ).resolves.toEqual({ applied: false });
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a missing user (deleted account replay) → applied:false + warn, not an error", async () => {
    const { logger, warn } = spyLogger();
    const { writer } = fakeWriter("user_missing");
    const apply = createRevenueCatHandler({ writer, config, logger });
    await expect(apply(event("RENEWAL"))).resolves.toEqual({ applied: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("createRevenueCatRoutes — the token-gated route", () => {
  function buildApp(writerResult: "applied" | "user_missing" = "applied") {
    const { logger } = spyLogger();
    const { writer, calls } = fakeWriter(writerResult);
    const app = Fastify({ logger: false });
    void app.register(
      createRevenueCatRoutes({ token: TOKEN, writer, config, logger }),
    );
    return { app, calls };
  }

  const PAYLOAD = { event: event("INITIAL_PURCHASE") };

  it("applies a purchase with the right bearer → 200 {applied:true}", async () => {
    const { app, calls } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/revenuecat",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true });
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it("missing bearer → 401, nothing written", async () => {
    const { app, calls } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/revenuecat",
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("wrong bearer → 401, nothing written", async () => {
    const { app, calls } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/revenuecat",
      headers: { authorization: "Bearer not-the-token" },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("malformed body → 400, nothing written", async () => {
    const { app, calls } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/revenuecat",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("unknown event type / product → 200 {applied:false} (vendor-proof)", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/revenuecat",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { event: event("SOME_FUTURE_EVENT") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: false });
    await app.close();
  });
});
