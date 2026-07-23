import cors from "@fastify/cors";
import {
  deletionResponseSchema,
  healthResponseSchema,
  meResponseSchema,
  type DeletionResponse,
  type HealthResponse,
  type MeResponse,
} from "@nova/shared";
import type { z } from "zod";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";

import { queueAccountDeletion } from "./db/account.js";
import { isSupabaseConfigured, SupabaseConfigError } from "./db/client.js";
import { isJobStoreConfigured, notesJobStoreFromEnv } from "./db/jobs.js";
import { createRagIndexerDb } from "./db/rag-indexer.js";
import { createStaleCallReaper } from "./db/stale-call-reaper.js";
import { isNotesWorkerEnabled } from "./env.js";
import { createNotesSource } from "./db/notes-source.js";
import {
  createFollowUpWriter,
  createNotesReader,
  createNotesWriter,
} from "./db/notes.js";
import {
  maybeCreateKillSwitch,
  maybeCreateMetering,
  maybeCreateQuotaChecker,
  maybeRegisterRevenueCatRoutes,
  voyageMeteringSink,
} from "./metering-wiring.js";
import { liveRoutes } from "./modules/live/routes.js";
import {
  type KillSwitch,
  type MeteringService,
  type QuotaChecker,
} from "./modules/metering/index.js";
import {
  AllProvidersFailedError,
  createLlmRouter,
  createProvidersFromEnv,
  llmConfigSchema,
  type LlmProviderEnv,
} from "./modules/llm/index.js";
import {
  createNotesJobHandler,
  createNotesPipeline,
  createNotesRoutes,
  createNotesWorker,
  generateFollowUp,
  type FollowUpInput,
  type FollowUpResult,
} from "./modules/notes/index.js";
import { createRagIndexer } from "./modules/rag/indexer.js";
import { createRagFromEnv } from "./modules/rag/index.js";
import { extractBearerToken, requireAuth } from "./plugins/auth.js";
import { withLogRedaction } from "./plugins/log-redaction.js";
import {
  rateLimitConfigSchema,
  registerRateLimit,
} from "./plugins/rate-limit.js";
import {
  generateRequestId,
  REQUEST_ID_HEADER,
  registerRequestId,
} from "./plugins/request-id.js";
import { version } from "./version.js";

export interface BuildAppOptions {
  /** Fastify logger config. Defaults to pino enabled; pass `false` in tests. */
  logger?: FastifyServerOptions["logger"];
  /** Rate-limit tunables (zod-defaulted 100/min); tests inject tiny windows. */
  rateLimit?: z.input<typeof rateLimitConfigSchema>;
}

/**
 * Build the Fastify app: request-id wiring + routes. Boot/env concerns live in
 * `index.ts` so this factory stays trivially testable via `app.inject()`.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    // withLogRedaction installs a req serializer that strips query strings from
    // logged urls — `/live?token=<JWT>` must never reach the logs (RULES: no
    // secrets in logs). Applied here so EVERY logger config gets it.
    logger: withLogRedaction(options.logger),
    // Honour an incoming x-request-id; otherwise mint one via genReqId.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: generateRequestId,
  });

  registerRequestId(app);

  // REST rate limiting (Phase 6, adr-0007 §6). Registered BEFORE every route so
  // the whole REST surface inherits it; the live WS route opts out via its own
  // `config: { rateLimit: false }` (concurrency-capped instead).
  void registerRateLimit(
    app,
    rateLimitConfigSchema.parse(options.rateLimit ?? {}),
  );

  // Dev-only affordance: the Expo *web* client fetches cross-origin (e.g.
  // localhost:8081 → :3000) and browsers enforce CORS. The on-device native app
  // sends no Origin header, so this never affects the real product surface. The
  // allowlist is restricted to localhost/127.0.0.1 on any port — no wildcard.
  //
  // `methods` is set explicitly to include DELETE: the CORS preflight for
  // `DELETE /account` (a non-simple request — it carries Authorization) is only
  // approved by the browser if DELETE is in Access-Control-Allow-Methods, and
  // this plugin's default set omits it.
  void app.register(cors, {
    origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/],
    methods: ["GET", "HEAD", "POST", "DELETE"],
  });

  // Live-call socket. liveRoutes registers @fastify/websocket in its own scope
  // then declares GET /live. Auth is enforced per-connection inside liveRoutes
  // (WS-close codes, not HTTP status), so no preHandler here.
  void app.register(liveRoutes);

  // Metering (Phase 6, adr-0007): ONE service over the usage_events ledger,
  // shared by every vendor construction site below. Env-gated on SUPABASE_DB_URL —
  // the same gate every metered consumer (worker / notes routes / RAG indexer)
  // already requires, so whenever any of them wires, the sink is REAL (the audit
  // invariant: no vendor path behind a noop sink).
  const metering = maybeCreateMetering(app);
  const quota = maybeCreateQuotaChecker(app, metering);
  const killSwitch = maybeCreateKillSwitch(app, metering);

  // Auto-index sweeper: closes the memory loop (call ends → chunks queryable
  // < 60s). Started only when RAG is configured AND not under test — unit/DB
  // suites drive the sweeper explicitly, never the boot-wired background one.
  maybeStartRagIndexer(app, metering);

  // Stale-call reaper: stamps ended_at on crashed-mid-call orphans (feeds BOTH RAG
  // and notes). Gated on the DB alone — same posture as the RAG indexer.
  maybeStartStaleCallReaper(app);

  // Post-call notes worker (poll loop + lease reaper + sweep backstop). Gated behind
  // NOTES_WORKER_ENABLED, so it stays off in tests/keyless boots unless opted in.
  maybeStartNotesWorker(app, metering, quota, killSwitch);

  // Post-call notes REST surface (read / regenerate / follow-up). Registered only
  // when the notes DB seam is configured, so a keyless/DB-less boot never mounts
  // broken routes (it just doesn't expose them — /health still serves).
  maybeRegisterNotesRoutes(app, metering, quota, killSwitch);

  // RevenueCat webhook (adr-0007 §7): server-to-server plan sync, registered
  // ONLY when REVENUECAT_WEBHOOK_TOKEN (+ the DB) is configured.
  maybeRegisterRevenueCatRoutes(app);

  // Direct root routes are declared inside `after()` so they register only once
  // the queued plugins (rate limit above all — it protects routes via an
  // `onRoute` hook, which cannot see routes added before it loads) are ready.
  app.after(() => {
    app.get("/health", (): HealthResponse => {
      // zod-parse the boundary even on the way out — the response shape is a
      // hard contract shared with the mobile app.
      return healthResponseSchema.parse({ ok: true, version });
    });

    // Protected: requireAuth resolves the caller's Supabase token to `request.user`
    // or short-circuits with 401/503, so by the time this handler runs the user is
    // present. We narrow defensively rather than assert, then parse the outgoing
    // body through the shared schema (house pattern — validate every boundary).
    app.get("/me", { preHandler: requireAuth }, (request): MeResponse => {
      const user = request.user;
      if (user === undefined) {
        // Unreachable: requireAuth either populated user or already replied.
        throw new Error("requireAuth did not populate request.user");
      }
      const body =
        user.email !== undefined
          ? { user_id: user.id, email: user.email }
          : { user_id: user.id };
      return meResponseSchema.parse(body);
    });

    // Protected: queue the caller's account for deletion (App Store mandate) and
    // tombstone their profile, then 202 with the queued request id. requireAuth
    // guarantees `request.user` and that a valid Bearer token was present, so we
    // can re-extract it to feed best-effort session revocation.
    app.delete(
      "/account",
      { preHandler: requireAuth },
      async (request, reply): Promise<FastifyReply> => {
        const user = request.user;
        if (user === undefined) {
          // Unreachable: requireAuth either populated user or already replied.
          throw new Error("requireAuth did not populate request.user");
        }
        const accessToken = extractBearerToken(request.headers.authorization);

        try {
          const row = await queueAccountDeletion(user.id, accessToken);
          // Parse the outgoing body through the shared schema (house pattern).
          const body: DeletionResponse = deletionResponseSchema.parse({
            status: "queued",
            request_id: row.id,
          });
          return await reply.code(202).send(body);
        } catch (error) {
          // Env unset/malformed on the DB path -> 503, consistent with
          // requireAuth's "server not configured" convention (not a client fault).
          if (error instanceof SupabaseConfigError) {
            return await reply.code(503).send({ error: "unavailable" });
          }
          // Anything else -> uniform 500, no detail leaked to the client.
          request.log.error({ err: error }, "queueAccountDeletion failed");
          return await reply.code(500).send({ error: "internal" });
        }
      },
    );
  });

  return app;
}

/**
 * Start the RAG completion sweeper on boot, but ONLY when RAG is configured
 * (`VOYAGE_API_KEY` + `SUPABASE_DB_URL` present) AND we are not under test — the
 * test suites construct and drive their own indexer. Stopped on server close.
 * The Voyage usage sink feeds the metering ledger (metering is always present
 * here: this gate requires SUPABASE_DB_URL, which is metering's own gate).
 */
function maybeStartRagIndexer(
  app: FastifyInstance,
  metering: MeteringService | undefined,
): void {
  const env = process.env;
  const ragConfigured =
    Boolean(env.VOYAGE_API_KEY) && Boolean(env.SUPABASE_DB_URL);
  if (!ragConfigured || env.NODE_ENV === "test") return;

  const ragService = createRagFromEnv(env, {
    logger: app.log,
    ...(metering ? { logUsage: voyageMeteringSink(metering, app) } : {}),
  });
  const indexer = createRagIndexer({
    ragService,
    db: createRagIndexerDb(),
    logger: app.log,
  });
  indexer.start();
  app.addHook("onClose", (_instance, done) => {
    indexer.stop();
    done();
  });
}

/**
 * Start the stale-call reaper on boot when the DB is configured (SUPABASE_DB_URL)
 * AND not under test — the integration suite drives its own reaper. It stamps
 * `ended_at` on orphaned meetings so both the RAG sweep and the notes queue pick
 * them up (adr-0006 §4). Stopped on server close.
 */
function maybeStartStaleCallReaper(app: FastifyInstance): void {
  if (!isJobStoreConfigured(process.env) || process.env.NODE_ENV === "test") {
    return;
  }
  const { pool } = notesJobStoreFromEnv(process.env);
  const reaper = createStaleCallReaper({ pool, logger: app.log });
  reaper.start();
  app.addHook("onClose", (_instance, done) => {
    reaper.stop();
    done();
  });
}

/** Only the LLM provider keys that are set — exactOptionalPropertyTypes-safe. */
function llmProviderEnv(env: NodeJS.ProcessEnv): LlmProviderEnv {
  const out: LlmProviderEnv = {};
  if (env.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) out.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.GOOGLE_API_KEY) out.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
  if (env.GROQ_API_KEY) out.GROQ_API_KEY = env.GROQ_API_KEY;
  return out;
}

/**
 * Start the notes worker on boot ONLY when explicitly enabled
 * (`NOTES_WORKER_ENABLED=true`) with the DB configured AND at least one LLM provider
 * key present, and never under test. Any missing precondition is a graceful no-op —
 * same posture as the RAG indexer. Wires the REAL pipeline-backed handler (Task 4):
 * the env-built failover router → `createNotesPipeline` → `createNotesJobHandler`
 * over the supabase-js read/write seams, driven by the durable `pg`-Pool queue.
 */
function maybeStartNotesWorker(
  app: FastifyInstance,
  metering: MeteringService | undefined,
  quota: QuotaChecker | undefined,
  killSwitch: KillSwitch | undefined,
): void {
  if (
    !isNotesWorkerEnabled(process.env) ||
    !isJobStoreConfigured(process.env) ||
    process.env.NODE_ENV === "test"
  ) {
    return;
  }
  const providers = createProvidersFromEnv(llmProviderEnv(process.env));
  if (providers.length === 0) {
    // Enabled + DB present but no LLM key: generation cannot run, so stay off
    // rather than claim jobs only to retry them forever.
    app.log.warn(
      "NOTES_WORKER_ENABLED set but no LLM provider key present — notes worker stays off",
    );
    return;
  }

  const { store } = notesJobStoreFromEnv(process.env);
  const router = createLlmRouter({
    providers,
    config: llmConfigSchema.parse({}),
  });
  // metering is always present here (this gate requires SUPABASE_DB_URL — its own
  // gate); the conditional spread only satisfies the type, never skips the sink.
  const pipeline = createNotesPipeline({
    router,
    logger: app.log,
    ...(metering
      ? {
          meterFor: (userId: string, meetingId?: string) =>
            metering.meterFor(userId, meetingId),
        }
      : {}),
  });
  const handler = createNotesJobHandler({
    pipeline,
    source: createNotesSource(),
    writer: createNotesWriter(),
    logger: app.log,
    // Claim-time llm quota gate (adr-0007 §4): over-quota jobs dead-letter with
    // 'quota_exceeded' so the paywall stays visible. Present whenever metering is.
    ...(quota
      ? {
          isOverLlmQuota: (userId: string) =>
            quota.isOverQuota(userId, "llm_tokens"),
        }
      : {}),
  });
  const worker = createNotesWorker({
    store,
    handler,
    logger: app.log,
    // Kill-switch claim gate (adr-0007 §5): tripped → no NEW claims, queued
    // jobs wait out the day, in-flight finishes.
    ...(killSwitch ? { isDailyCapReached: () => killSwitch.isTripped() } : {}),
  });
  worker.start();
  app.addHook("onClose", (_instance, done) => {
    worker.stop();
    done();
  });
}

/**
 * Register the notes REST surface when BOTH the supabase-js read/write seam
 * (SUPABASE_URL + SERVICE_ROLE_KEY) and the pg-Pool job store (SUPABASE_DB_URL) are
 * configured — otherwise a keyless/DB-less boot would mount routes whose seams throw
 * on first use. The follow-up call needs an LLM router: when no provider key is
 * present the GET/regenerate routes still work and follow-up cleanly returns the
 * typed 503 `provider_unavailable` (an injected runner that rejects with
 * `AllProvidersFailedError`, mapped by the route). Request-scoped, so — unlike the
 * background worker — it is NOT gated on NODE_ENV.
 */
function maybeRegisterNotesRoutes(
  app: FastifyInstance,
  metering: MeteringService | undefined,
  quota: QuotaChecker | undefined,
  killSwitch: KillSwitch | undefined,
): void {
  if (
    !isSupabaseConfigured(process.env) ||
    !isJobStoreConfigured(process.env)
  ) {
    return;
  }

  const providers = createProvidersFromEnv(llmProviderEnv(process.env));
  // metering is always present here (this gate requires SUPABASE_DB_URL — its own
  // gate); the conditional spread only satisfies the type, never skips the sink.
  const followUp: (input: FollowUpInput) => Promise<FollowUpResult> =
    providers.length > 0
      ? generateFollowUp({
          router: createLlmRouter({
            providers,
            config: llmConfigSchema.parse({}),
          }),
          logger: app.log,
          ...(metering
            ? {
                meterFor: (userId: string, meetingId?: string) =>
                  metering.meterFor(userId, meetingId),
              }
            : {}),
        })
      : () => Promise.reject(new AllProvidersFailedError([]));

  const { store } = notesJobStoreFromEnv(process.env);
  void app.register(
    createNotesRoutes({
      reader: createNotesReader(),
      followUpWriter: createFollowUpWriter(),
      store,
      followUp,
      logger: app.log,
      // Request-time llm quota gate for follow-up (typed 429 quota_exceeded).
      ...(quota
        ? {
            isOverLlmQuota: (userId: string) =>
              quota.isOverQuota(userId, "llm_tokens"),
          }
        : {}),
      // Kill-switch gate for follow-up (typed 503 daily_cap_reached).
      ...(killSwitch
        ? { isDailyCapReached: () => killSwitch.isTripped() }
        : {}),
    }),
  );
}
