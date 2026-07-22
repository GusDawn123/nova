import type { Pool } from "pg";
import { z } from "zod";

import type { PlanReader } from "../modules/metering/quota.js";

/**
 * `PlanReader` over a direct `pg` Pool — the user-scoped `profiles.plan` lookup
 * the quota checker binds limits with (adr-0007 §4). House db-seam style:
 * explicit columns, rows re-parsed at the boundary. Read-only; the plan WRITER
 * (RevenueCat webhook) arrives in Task 5.
 */

/** Matches the `profiles_plan_check` CHECK — the DB is the source of truth. */
const planRowSchema = z.object({ plan: z.enum(["free", "pro"]) });

/** Build a {@link PlanReader} over an explicit pool (pure of env). */
export function createPlanReader(pool: Pool): PlanReader {
  return {
    async getPlan(userId: string) {
      const res = await pool.query(
        `select plan from profiles where id = $1 and deleted_at is null`,
        [userId],
      );
      if (res.rowCount === 0) {
        // No live profile row (deleted mid-flight or trigger race): bind the most
        // restrictive plan rather than failing the check.
        return "free";
      }
      return planRowSchema.parse(res.rows[0]).plan;
    },
  };
}
