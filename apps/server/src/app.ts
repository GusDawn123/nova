import cors from "@fastify/cors";
import { healthResponseSchema, type HealthResponse } from "@nova/shared";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

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

  return app;
}
