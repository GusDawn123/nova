import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@nova/shared";

import type { RoleReader } from "../db/roles.js";

/**
 * `requireRole` — the role-gate preHandler seam (adr-0008). Composed AFTER
 * `requireAuth` in a route's preHandler array; it resolves the authenticated
 * caller's `profiles.role` through the injected {@link RoleReader} and refuses
 * anyone outside the allowed set with a typed 403.
 *
 * Failure posture (adr-0008, mirroring the meeting-ownership guard):
 *   - reader not wired (DB-less boot) → 503 `unavailable` — a role-gated route
 *     cannot exist meaningfully without the DB; misconfig is not a client fault;
 *   - reader THROWS (DB down mid-request) → 403 fail CLOSED — a privilege gate
 *     never fail-opens (quota's fail-open protects spend; this protects access);
 *   - missing `request.user` → 401 (requireAuth was not composed first — a
 *     wiring bug surfaced as the same uniform response a tokenless call gets).
 *
 * No consumers yet — this is the seam future admin/developer routes compose.
 */

const UNAVAILABLE = { error: "unavailable" } as const;
const UNAUTHORIZED = { error: "unauthorized" } as const;
const FORBIDDEN = { error: "forbidden" } as const;

/**
 * The async-preHandler shape `requireAuth` also uses (Fastify accepts promise
 * handlers; the `preHandlerHookHandler` alias's done-callback overload trips
 * `no-misused-promises`, so the concrete async signature is used instead).
 */
export type RolePreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export interface RequireRoleFactory {
  (allowed: readonly Role[]): RolePreHandler;
}

/**
 * Build the factory over an injected reader (undefined = DB-less boot). Routes
 * call `createRequireRole(reader)(["developer","admin"])`.
 */
export function createRequireRole(
  reader: RoleReader | undefined,
): RequireRoleFactory {
  return (allowed: readonly Role[]): RolePreHandler => {
    return async function requireRole(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> {
      if (reader === undefined) {
        await reply.code(503).send(UNAVAILABLE);
        return;
      }
      const user = request.user;
      if (user === undefined) {
        // requireAuth must run first; treat the gap as unauthenticated.
        await reply.code(401).send(UNAUTHORIZED);
        return;
      }
      let role: Role;
      try {
        role = await reader.getRole(user.id);
      } catch (err: unknown) {
        // Fail CLOSED (privilege gate = ownership posture). Ids only in logs.
        request.log.error({ user_id: user.id, err }, "role.check_failed");
        await reply.code(403).send(FORBIDDEN);
        return;
      }
      if (!allowed.includes(role)) {
        await reply.code(403).send(FORBIDDEN);
        return;
      }
      // Allowed: fall through to the handler.
    };
  };
}
