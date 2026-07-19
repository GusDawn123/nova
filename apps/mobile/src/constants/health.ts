import { healthResponseSchema, type HealthResponse } from '@nova/shared';

// Proves the mobile workspace resolves packages/shared (typecheck + metro).
// A later task fetches GET /health from the server and validates it with this schema.
export const HEALTH_ENDPOINT = '/health';

export type MobileHealthResponse = HealthResponse;

export const SAMPLE_HEALTH: HealthResponse = healthResponseSchema.parse({
  ok: true,
  version: '0.0.0',
});
