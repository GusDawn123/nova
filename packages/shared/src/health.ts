import { z } from "zod";

/**
 * Shape of `GET /health`. A later server task returns exactly `{ ok: true, version }`.
 */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
