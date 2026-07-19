import { z } from "zod";

/**
 * Shape of `GET /me` — the identity the server resolved from the caller's
 * Supabase access token. `user_id` is the JWT `sub` (a uuid); `email` is
 * included only when the token carried one.
 */
export const meResponseSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email().optional(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
