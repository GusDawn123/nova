import type { Pool } from "pg";
import { z } from "zod";

import type { PlanId } from "../modules/metering/config.js";
import type { PlanReader } from "../modules/metering/quota.js";
import type { PlanWriter } from "../modules/metering/revenuecat.js";

/**
 * `PlanReader`/`PlanWriter` over a direct `pg` Pool — the user-scoped
 * `profiles.plan` seams (adr-0007 §4/§7). House db-seam style: explicit
 * columns, rows re-parsed at the boundary. The reader binds quota limits; the
 * writer applies RevenueCat plan changes.
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

/** Build a {@link PlanWriter} over an explicit pool (pure of env). */
export function createPlanWriter(pool: Pool): PlanWriter {
  return {
    async setPlan(userId: string, plan: PlanId) {
      // Live-profile-scoped: a deleted account's replayed webhook is a
      // `user_missing`, never an error (the caller warns + answers 200).
      const res = await pool.query(
        `update profiles set plan = $1 where id = $2 and deleted_at is null`,
        [plan, userId],
      );
      return (res.rowCount ?? 0) === 1 ? "applied" : "user_missing";
    },
  };
}
