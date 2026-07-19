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

  app.get("/health", (): HealthResponse => {
    // zod-parse the boundary even on the way out — the response shape is a
    // hard contract shared with the mobile app.
    return healthResponseSchema.parse({ ok: true, version });
  });

  return app;
}
