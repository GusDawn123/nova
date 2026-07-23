import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlanReader } from "./plans.js";

/**
 * `PlanReader` integration proof against the LIVE local Supabase Postgres:
 * default 'free' (trigger-provisioned profile), 'pro' after a service-role plan
 * update, most-restrictive 'free' for a missing/soft-deleted profile. Self-skips
 * unless the stack env is present.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

describe.skipIf(!hasStack)("PlanReader (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let userId: string;

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const created = await admin.auth.admin.createUser({
      email: `plans-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user.id;
  });

  afterAll(async () => {
    await admin.auth.admin.deleteUser(userId);
    await pool.end();
  });

  it("[plans] a fresh profile reads the default 'free'", async () => {
    const reader = createPlanReader(pool);
    await expect(reader.getPlan(userId)).resolves.toBe("free");
  });

  it("[plans] reads 'pro' after a service-role plan update", async () => {
    await pool.query(`update profiles set plan = 'pro' where id = $1`, [
      userId,
    ]);
    const reader = createPlanReader(pool);
    await expect(reader.getPlan(userId)).resolves.toBe("pro");
  });

  it("[plans] a soft-deleted profile binds the most restrictive 'free'", async () => {
    await pool.query(`update profiles set deleted_at = now() where id = $1`, [
      userId,
    ]);
    const reader = createPlanReader(pool);
    await expect(reader.getPlan(userId)).resolves.toBe("free");
    // Restore for teardown hygiene (auth delete cascades anyway).
    await pool.query(
      `update profiles set deleted_at = null, plan = 'free' where id = $1`,
      [userId],
    );
  });

  it("[plans] an unknown user id reads 'free' (no row)", async () => {
    const reader = createPlanReader(pool);
    await expect(reader.getPlan(randomUUID())).resolves.toBe("free");
  });
});
