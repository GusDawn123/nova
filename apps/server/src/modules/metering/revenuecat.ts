import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { extractBearerToken } from "../../plugins/auth.js";
import { meteringConfig, type MeteringConfig, type PlanId } from "./config.js";
import type { MeteringLogger } from "./ports.js";

/**
 * RevenueCat webhook seam (adr-0007 §7): fixture-tested plan sync — the LIVE
 * RevenueCat account, product catalog, and the mobile SDK setting `app_user_id`
 * are Phase 8+ items. Billing state lives in `profiles.plan` only.
 *
 * HOSTILE BOUNDARY (RULES §1 — vendor webhook payloads are explicitly listed):
 * the body is zod-parsed defensively, and every vendor surprise — a new event
 * type, an unmapped product, an anonymous `app_user_id`, a replay for a deleted
 * account — answers 200 `{applied:false}` plus a warn, NEVER a 500 (a vendor
 * shipping a new event type must not page us as an outage).
 *
 * EVENT READING (RevenueCat's documented types; my Task-5 reading, stated):
 *   - INITIAL_PURCHASE / RENEWAL / UNCANCELLATION → the mapped product's plan
 *     ('pro'): the entitlement is (re)active.
 *   - EXPIRATION → 'free': the entitlement actually ENDED. CANCELLATION alone
 *     is auto-renew turned OFF — access runs to period end, so it deliberately
 *     does NOT downgrade (the later EXPIRATION does; DESIGN's
 *     "CANCELLATION+EXPIRATION / EXPIRATION → free").
 *   - Other documented types (CANCELLATION, NON_RENEWING_PURCHASE,
 *     BILLING_ISSUE, SUBSCRIPTION_PAUSED, PRODUCT_CHANGE, TRANSFER,
 *     SUBSCRIPTION_EXTENDED, TEST) are KNOWN no-ops today: `{applied:false}`
 *     with an info line, no warn (expected traffic is not an anomaly).
 *   - Anything else is unknown → `{applied:false}` + warn.
 */

// ---------------------------------------------------------------------------
// The wire envelope (subset relied on; unknown keys ignored).
// ---------------------------------------------------------------------------

/** RevenueCat wraps the event: `{ api_version, event: { type, app_user_id, … } }`. */
export const revenueCatEnvelopeSchema = z.object({
  event: z.object({
    type: z.string().min(1),
    /** The Supabase user uuid — the mobile SDK sets it at login (Phase 8). */
    app_user_id: z.string().min(1),
    product_id: z.string().min(1).optional(),
  }),
});

export type RevenueCatEvent = z.infer<typeof revenueCatEnvelopeSchema>["event"];

// ---------------------------------------------------------------------------
// Ports + mapping.
// ---------------------------------------------------------------------------

/** User-scoped plan write — implemented by `db/plans.ts` (explicit columns). */
export interface PlanWriter {
  /** `user_missing` = no live profile row (deleted account replay — not an error). */
  setPlan(userId: string, plan: PlanId): Promise<"applied" | "user_missing">;
}

/** Entitlement (re)activated → the mapped product's plan. */
const UPGRADE_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
]);
/** Entitlement actually ended → 'free'. */
const DOWNGRADE_EVENTS = new Set(["EXPIRATION"]);
/** Documented types that change nothing today (see the module header). */
const KNOWN_NOOP_EVENTS = new Set([
  "CANCELLATION",
  "NON_RENEWING_PURCHASE",
  "BILLING_ISSUE",
  "SUBSCRIPTION_PAUSED",
  "PRODUCT_CHANGE",
  "TRANSFER",
  "SUBSCRIPTION_EXTENDED",
  "TEST",
]);

const uuidSchema = z.string().uuid();

export interface RevenueCatHandlerDeps {
  readonly writer: PlanWriter;
  readonly config?: MeteringConfig;
  readonly logger: MeteringLogger;
}

/**
 * Build the pure event applier: one zod-parsed event in, `{applied}` out.
 * Idempotent by construction — the plan write is an absolute SET, so a replay
 * lands the same terminal state.
 */
export function createRevenueCatHandler(
  deps: RevenueCatHandlerDeps,
): (event: RevenueCatEvent) => Promise<{ applied: boolean }> {
  const { writer, logger } = deps;
  const config = deps.config ?? meteringConfig;

  return async function apply(event) {
    const base = {
      event_type: event.type,
      product_id: event.product_id ?? null,
    };

    let targetPlan: PlanId;
    if (UPGRADE_EVENTS.has(event.type) || DOWNGRADE_EVENTS.has(event.type)) {
      // Both directions require a product WE manage: an upgrade grants its
      // mapped plan; its expiration falls back to 'free'. An unmapped product
      // is someone else's catalog entry — never guess a plan from it.
      const granted = event.product_id
        ? config.revenuecatProducts[event.product_id]
        : undefined;
      if (granted === undefined) {
        logger.warn(base, "revenuecat.unknown_product: not applied");
        return { applied: false };
      }
      targetPlan = UPGRADE_EVENTS.has(event.type) ? granted : "free";
    } else if (KNOWN_NOOP_EVENTS.has(event.type)) {
      logger.info(base, "revenuecat.event_noop");
      return { applied: false };
    } else {
      logger.warn(base, "revenuecat.unknown_event_type: not applied");
      return { applied: false };
    }

    // `app_user_id` must be the Supabase uuid; RevenueCat anonymous ids
    // ($RCAnonymousID:…) belong to not-yet-logged-in devices → nothing to bill.
    const userId = uuidSchema.safeParse(event.app_user_id);
    if (!userId.success) {
      logger.warn(base, "revenuecat.unmatched_app_user_id: not applied");
      return { applied: false };
    }

    const outcome = await writer.setPlan(userId.data, targetPlan);
    if (outcome === "user_missing") {
      // Replays for deleted accounts are expected vendor behavior — warn, 200.
      logger.warn(
        { ...base, user_id: userId.data },
        "revenuecat.user_missing: not applied",
      );
      return { applied: false };
    }
    logger.info(
      { ...base, user_id: userId.data, plan: targetPlan },
      "revenuecat.plan_applied",
    );
    return { applied: true };
  };
}

// ---------------------------------------------------------------------------
// The route (token-gated; registered by app wiring ONLY when the env token is set).
// ---------------------------------------------------------------------------

/** Constant-time bearer check: sha-256 both sides, then timingSafeEqual. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = extractBearerToken(header);
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export interface RevenueCatRoutesDeps extends RevenueCatHandlerDeps {
  /** The shared webhook secret (`REVENUECAT_WEBHOOK_TOKEN`). */
  readonly token: string;
}

/**
 * `POST /webhooks/revenuecat` — server-to-server: the bearer token IS the auth
 * (no requireAuth; there is no end-user JWT on a vendor callback). 401 on a
 * missing/wrong bearer, 400 on a structurally malformed body, otherwise 200
 * `{applied: true|false}`.
 */
export function createRevenueCatRoutes(
  deps: RevenueCatRoutesDeps,
): (app: FastifyInstance) => Promise<void> {
  const apply = createRevenueCatHandler(deps);

  // eslint-disable-next-line @typescript-eslint/require-await
  return async function revenueCatRoutes(app: FastifyInstance): Promise<void> {
    app.post("/webhooks/revenuecat", async (request, reply) => {
      if (!bearerMatches(request.headers.authorization, deps.token)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = revenueCatEnvelopeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      return reply.code(200).send(await apply(parsed.data.event));
    });
  };
}
