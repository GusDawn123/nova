import { z } from "zod";

/**
 * Shape of `DELETE /account` — the server has enqueued the caller's account for
 * deletion and tombstoned their profile. `request_id` is the id of the queued
 * `deletion_requests` row (a uuid); the actual purge runs asynchronously in a
 * later phase. `status` is a literal so the client branches on a discriminant,
 * not a free-form string.
 */
export const deletionResponseSchema = z.object({
  status: z.literal("queued"),
  request_id: z.string().uuid(),
});

export type DeletionResponse = z.infer<typeof deletionResponseSchema>;
