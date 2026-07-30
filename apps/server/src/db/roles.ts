import type { Pool } from "pg";
import { z } from "zod";
import { type Role } from "@nova/shared";

/**
 * `RoleReader` over a direct `pg` Pool — the user-scoped `profiles.role` seam
 * (adr-0008). Mirrors `db/plans.ts` house style: explicit columns, rows
 * re-parsed at the boundary against the shared enum (which mirrors the
 * `profiles_role_check` DB CHECK — the DB is the source of truth).
 *
 * A missing or soft-deleted profile resolves to the LEAST-privileged
 * `'customer'` — the same most-restrictive posture as PlanReader's 'free'.
 * A DB ERROR, by contrast, REJECTS: privilege checks fail CLOSED at the
 * consumer (plugins/role.ts), unlike quota's fail-open (quota protects spend;
 * a role gate protects access — the ownership posture).
 */

export interface RoleReader {
  getRole(userId: string): Promise<Role>;
}

/**
 * Matches `profiles_role_check`. The enum is declared LOCALLY (not composed
 * from the shared `roleSchema`) because embedding a schema built by another
 * package's zod instance inside this package's `z.object` breaks at parse time
 * (cross-instance `_parse` mismatch) — same reason plans.ts declares its enum
 * locally. The shared `Role` TYPE keeps the two in lockstep at compile time.
 */
const roleRowSchema = z.object({
  role: z.enum(["developer", "admin", "customer"]),
});

/** Build a {@link RoleReader} over an explicit pool (pure of env). */
export function createRoleReader(pool: Pool): RoleReader {
  return {
    async getRole(userId: string): Promise<Role> {
      const res = await pool.query(
        `select role from profiles where id = $1 and deleted_at is null`,
        [userId],
      );
      if (res.rowCount === 0) {
        // No live profile row (deleted mid-flight or trigger race): the
        // least-privileged role, never a throw — absence is not an error.
        return "customer";
      }
      return roleRowSchema.parse(res.rows[0]).role;
    },
  };
}
