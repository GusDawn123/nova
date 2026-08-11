import type { FastifyInstance } from "fastify";

import { createPlanReader, createPlanWriter } from "./db/plans.js";
import {
  isUsageEventsConfigured,
  usageEventsDbFromEnv,
} from "./db/usage-events.js";
import {
  createLiveConductor,
  type LiveConductorFactory,
} from "./modules/live/conductor.js";
import type { LiveMetering } from "./modules/live/ports.js";
import {
  createLlmRouter,
  createProvidersFromEnv,
  liveLlmConfig,
  type LlmProviderEnv,
} from "./modules/llm/index.js";
import {
  createKillSwitch,
  createMeteringService,
  createQuotaChecker,
  createRevenueCatRoutes,
  type KillSwitch,
  type MeteringService,
  type QuotaChecker,
} from "./modules/metering/index.js";
import { createRagFromEnv, type VoyageUsageLog } from "./modules/rag/index.js";

/**
 * Metering boot wiring (Phase 6, adr-0007) — split out of `app.ts` (RULES §2 file
 * cap). `app.ts` calls these to build the ONE process-wide metering service and
 * the Voyage usage sink; the audit test (`modules/metering/metering.audit.test.ts`)
 * statically scans BOTH files to enforce the no-unmetered-vendor-path invariant.
 */

/**
 * Build the ONE process-wide {@link MeteringService} over the `usage_events`
 * ledger when the DB is configured (`SUPABASE_DB_URL`). Undefined on a DB-less
 * boot — where no metered consumer mounts either, so no vendor path ever runs
 * without the sink (the audit invariant).
 */
export function maybeCreateMetering(
  app: FastifyInstance,
): MeteringService | undefined {
  if (!isUsageEventsConfigured(process.env)) return undefined;
  const { db } = usageEventsDbFromEnv(process.env);
  return createMeteringService({ db, logger: app.log });
}

/**
 * Map a Voyage usage line onto the metering ledger: `embedding` lines bill their
 * token count as `embedding_tokens` under the TRUE per-tier vendor model;
 * `rerank` lines bill ONE `rerank_requests` (priced $/1k requests). An
 * unattributed line (no user on the port — must not happen on wired paths, the
 * rag service always threads userId) is warn-logged and dropped, never invented.
 */
export function voyageMeteringSink(
  metering: MeteringService,
  app: FastifyInstance,
): (entry: VoyageUsageLog) => void {
  return (entry) => {
    if (entry.user_id === null) {
      app.log.warn(
        { vendor: entry.vendor, kind: entry.kind, model: entry.model },
        "metering.voyage_unattributed: usage line carried no user_id — dropped",
      );
      return;
    }
    // record() never throws (adr-0007 §1) — fire-and-forget is safe here.
    void metering.record({
      userId: entry.user_id,
      vendor: entry.vendor,
      kind: entry.kind === "rerank" ? "rerank_requests" : "embedding_tokens",
      amount: entry.kind === "rerank" ? 1 : entry.tokens,
      model: entry.model,
    });
  };
}

/**
 * Build the plan-quota checker over the same pool + service (Phase 6, adr-0007
 * §4). Undefined exactly when metering is (DB-less boot — no enforcement without
 * a ledger, matching the seams-optional posture everywhere).
 */
export function maybeCreateQuotaChecker(
  app: FastifyInstance,
  metering: MeteringService | undefined,
): QuotaChecker | undefined {
  if (!metering || !isUsageEventsConfigured(process.env)) return undefined;
  const { pool } = usageEventsDbFromEnv(process.env);
  return createQuotaChecker({
    usedInPeriod: (userId, kind) => metering.usedInPeriod(userId, kind),
    plans: createPlanReader(pool),
    logger: app.log,
  });
}

/**
 * ONE kill-switch per process (module-memoised like the pools): its
 * once-per-UTC-day alert dedupe is a PROCESS-level guarantee, and both the
 * app-level consumers (worker claim gate, follow-up) and the live transport
 * must share the same dedupe state. The first builder's logger wins (the alert
 * is process-scoped, not request-scoped).
 */
let cachedKillSwitch: KillSwitch | undefined;

export function maybeCreateKillSwitch(
  app: FastifyInstance,
  metering: MeteringService | undefined,
): KillSwitch | undefined {
  if (!metering) return undefined;
  cachedKillSwitch ??= createKillSwitch({
    spendTodayUsd: () => metering.spendTodayUsd(),
    logger: app.log,
  });
  return cachedKillSwitch;
}

/**
 * Adapt the metering service + quota checker onto the live module's
 * {@link LiveMetering} seam (modules stay islands — the session types against
 * its own port, this wiring bridges them): relayed-audio spans land as
 * `stt_seconds` usage events; the quota question is the stt-seconds plan check.
 */
export function maybeCreateLiveMetering(
  app: FastifyInstance,
): LiveMetering | undefined {
  const metering = maybeCreateMetering(app);
  const quota = maybeCreateQuotaChecker(app, metering);
  const killSwitch = maybeCreateKillSwitch(app, metering);
  if (!metering || !quota || !killSwitch) return undefined;
  return {
    recordSttSeconds: ({ userId, meetingId, vendor, seconds }) =>
      metering.record({
        userId,
        meetingId,
        vendor,
        kind: "stt_seconds",
        amount: seconds,
      }),
    isOverSttQuota: (userId) => quota.isOverQuota(userId, "stt_seconds"),
    isOverDailyCap: () => killSwitch.isTripped(),
  };
}

/** Only the LLM provider keys that are set (exactOptionalPropertyTypes-safe). */
function liveLlmProviderEnv(env: NodeJS.ProcessEnv): LlmProviderEnv {
  const out: LlmProviderEnv = {};
  if (env.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) out.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.GOOGLE_API_KEY) out.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
  if (env.GROQ_API_KEY) out.GROQ_API_KEY = env.GROQ_API_KEY;
  return out;
}

/**
 * Build the live copilot conductor factory (Phase 7) — the LLM-suggestion path
 * of the live session, wired THROUGH the metering seam (adr-0007: no unmetered
 * vendor call). Constructs ONE live-tuned failover router (cheapest-first
 * cascade, tight TTFT/stall budgets) shared across sessions, the per-user RAG
 * service for grounding (its Voyage usage lands on the ledger via the same sink
 * as the notes/indexer paths), and threads `metering.meterFor(userId, meetingId)`
 * into every suggestion call so each streamed token is attributed.
 *
 * Undefined when NO LLM provider key is present — the session still transcribes,
 * it just streams no suggestions (the keyless posture, like RAG/STT).
 */
export function maybeCreateLiveConductorFactory(
  app: FastifyInstance,
): LiveConductorFactory | undefined {
  const providers = createProvidersFromEnv(liveLlmProviderEnv(process.env));
  if (providers.length === 0) return undefined;

  // FAIL CLOSED.
  // why: this used to build the router first and treat metering as optional
  // (`...(metering ? { meter } : {})`), so a deployment holding vendor keys but no
  // `usage_events` DB streamed real suggestions — and their Voyage grounding —
  // that never reached the ledger. That is the unmetered vendor path the hard
  // prohibition forbids, so the conductor must not exist without its meter.
  const metering = maybeCreateMetering(app);
  if (!metering) return undefined;

  const router = createLlmRouter({ providers, config: liveLlmConfig() });
  const rag = createRagFromEnv(process.env, {
    logger: app.log,
    logUsage: voyageMeteringSink(metering, app),
  });

  return ({ send, userId, meetingId, mode }) =>
    createLiveConductor({
      send,
      router,
      rag,
      userId,
      meetingId,
      // The mode the caller picked on the Live screen, parsed off `session.start`
      // (Phase 8.6). Per-session by construction: the router and RAG service above
      // are shared, the mode is not.
      mode,
      logger: app.log,
      // The per-call meter (adr-0007 §2): attribution travels with the call while
      // the router's breaker/bench state stays process-global.
      meter: metering.meterFor(userId, meetingId),
    });
}

/**
 * Register the RevenueCat webhook (adr-0007 §7) ONLY when BOTH the shared
 * secret (`REVENUECAT_WEBHOOK_TOKEN`) and the DB (`SUPABASE_DB_URL` — the plan
 * writer's pool) are configured. Absent either, the route does not exist (404)
 * — the seam stays dark until billing goes live (Phase 8).
 */
export function maybeRegisterRevenueCatRoutes(app: FastifyInstance): void {
  const token = process.env.REVENUECAT_WEBHOOK_TOKEN;
  if (
    token === undefined ||
    token === "" ||
    !isUsageEventsConfigured(process.env)
  ) {
    return;
  }
  const { pool } = usageEventsDbFromEnv(process.env);
  void app.register(
    createRevenueCatRoutes({
      token,
      writer: createPlanWriter(pool),
      logger: app.log,
    }),
  );
}
