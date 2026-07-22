import cors from "@fastify/cors";
import {
  deletionResponseSchema,
  healthResponseSchema,
  meResponseSchema,
  type DeletionResponse,
  type HealthResponse,
  type MeResponse,
} from "@nova/shared";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";

import { queueAccountDeletion } from "./db/account.js";
import { SupabaseConfigError } from "./db/client.js";
import { createRagIndexerDb } from "./db/rag-indexer.js";
import { liveRoutes } from "./modules/live/routes.js";
import { createRagIndexer } from "./modules/rag/indexer.js";
import { createRagFromEnv } from "./modules/rag/index.js";
import { extractBearerToken, requireAuth } from "./plugins/auth.js";
import { withLogRedaction } from "./plugins/log-redaction.js";
import {
  generateRequestId,
  REQUEST_ID_HEADER,
  registerRequestId,
} from "./plugins/request-id.js";
import { version } from "./version.js";

export interface BuildAppOptions {
  /** Fastify logger config. Defaults to pino enabled; pass `false` in tests. */
  logger?: FastifyServerOptions["logger"];
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

  // Auto-index sweeper: closes the memory loop (call ends → chunks queryable
  // < 60s). Started only when RAG is configured AND not under test — unit/DB
  // suites drive the sweeper explicitly, never the boot-wired background one.
  maybeStartRagIndexer(app);

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

  return app;
}

/**
 * Start the RAG completion sweeper on boot, but ONLY when RAG is configured
 * (`VOYAGE_API_KEY` + `SUPABASE_DB_URL` present) AND we are not under test — the
 * test suites construct and drive their own indexer. Stopped on server close.
 */
function maybeStartRagIndexer(app: FastifyInstance): void {
  const env = process.env;
  const ragConfigured =
    Boolean(env.VOYAGE_API_KEY) && Boolean(env.SUPABASE_DB_URL);
  if (!ragConfigured || env.NODE_ENV === "test") return;

  const ragService = createRagFromEnv(env, { logger: app.log });
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
