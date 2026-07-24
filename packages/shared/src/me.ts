import { z } from "zod";

/**
 * The permission roles (adr-0008): `developer` (internal builders — test
 * surfaces, future debug tooling), `admin` (operational control, user
 * management — future), `customer` (the default everyone starts as). Mirrors
 * the `profiles_role_check` DB CHECK — the DB is the source of truth.
 */
export const roleSchema = z.enum(["developer", "admin", "customer"]);
export type Role = z.infer<typeof roleSchema>;

/**
 * Shape of `GET /me` — the identity the server resolved from the caller's
 * Supabase access token. `user_id` is the JWT `sub` (a uuid); `email` is
 * included only when the token carried one. `role` (adr-0008) is read from
 * `profiles.role` and is OPTIONAL on the wire: a DB-less server boot cannot
 * resolve it and omits the field (clients treat absent as `customer`).
 */
export const meResponseSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email().optional(),
  role: roleSchema.optional(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
