import cors from "@fastify/cors";
import {
  healthResponseSchema,
  meResponseSchema,
  type HealthResponse,
  type MeResponse,
} from "@nova/shared";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { requireAuth } from "./plugins/auth.js";
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
    logger: options.logger ?? true,
    // Honour an incoming x-request-id; otherwise mint one via genReqId.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: generateRequestId,
  });

  registerRequestId(app);

  // Dev-only affordance: the Expo *web* client fetches cross-origin (e.g.
  // localhost:8081 → :3000) and browsers enforce CORS. The on-device native app
  // sends no Origin header, so this never affects the real product surface. The
  // allowlist is restricted to localhost/127.0.0.1 on any port — no wildcard.
  void app.register(cors, {
    origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/],
  });

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

  return app;
}
