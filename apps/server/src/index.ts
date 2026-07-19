import { healthResponseSchema, type HealthResponse } from "@nova/shared";

/**
 * Placeholder entrypoint. The real Fastify server (with a `GET /health` route
 * returning this shape) arrives in a later task. For now this proves the server
 * workspace imports and uses the shared zod schema.
 */
const health: HealthResponse = healthResponseSchema.parse({
  ok: true,
  version: "0.0.0",
});

console.log("[nova/server] shared HealthResponse parsed:", health);
