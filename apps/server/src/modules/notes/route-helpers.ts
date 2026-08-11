import type { FastifyRequest } from "fastify";

/**
 * What BOTH notes route files need (`routes.ts` and
 * `item-completion-routes.ts`), extracted so neither imports the other — the
 * completion routes are registered BY `routes.ts`, so a back-import would be a
 * cycle.
 *
 * Everything here is pure or near-pure: no I/O, no clock, no throw except the one
 * unreachable invariant below.
 */

/**
 * The authenticated caller's id (requireAuth guarantees `request.user` is set).
 *
 * The throw is an invariant assertion, not an error path: `requireAuth` runs as a
 * preHandler and either populates `request.user` or replies 401/503 before any
 * handler runs. Narrowing rather than asserting keeps `any` out (RULES §1).
 */
export function userIdOf(request: FastifyRequest): string {
  const user = request.user;
  if (user === undefined) {
    // Unreachable: requireAuth either populated user or already replied.
    throw new Error("requireAuth did not populate request.user");
  }
  return user.id;
}
