import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

/**
 * Header carrying the request id across the client/server boundary. Configured
 * as Fastify's `requestIdHeader`, so an incoming value becomes `request.id`.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Fastify `genReqId`: mint a fresh id when the request has no
 * `x-request-id` header. Kept alongside the header config so request-id
 * behaviour lives in one place.
 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Echo the resolved request id (incoming or generated) back to the client.
 * The id is already threaded through every pino log line by Fastify via
 * `request.id`, so this only adds the response header.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook("onRequest", (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}
