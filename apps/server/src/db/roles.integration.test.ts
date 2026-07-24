import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRoleReader } from "./roles.js";

/**
 * `RoleReader` integration proof against the LIVE local Supabase Postgres
 * (adr-0008): default 'customer' (trigger-provisioned profile), 'developer'
 * after a service-role role update, least-privileged 'customer' for a
 * missing/soft-deleted profile, and the DB CHECK rejecting an unknown role.
 * Self-skips unless the stack env is present (plans.integration house style).
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

describe.skipIf(!hasStack)("RoleReader (local stack)", () => {
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
      email: `roles-${randomUUID()}@nova.test`,
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

  it("[roles] a fresh profile reads the default 'customer'", async () => {
    const reader = createRoleReader(pool);
    await expect(reader.getRole(userId)).resolves.toBe("customer");
  });

  it("[roles] reads 'developer' after a service-role role update", async () => {
    await pool.query(`update profiles set role = 'developer' where id = $1`, [
      userId,
    ]);
    const reader = createRoleReader(pool);
    await expect(reader.getRole(userId)).resolves.toBe("developer");
  });

  it("[roles] a soft-deleted profile binds the least-privileged 'customer'", async () => {
    await pool.query(`update profiles set deleted_at = now() where id = $1`, [
      userId,
    ]);
    const reader = createRoleReader(pool);
    await expect(reader.getRole(userId)).resolves.toBe("customer");
    await pool.query(
      `update profiles set deleted_at = null, role = 'customer' where id = $1`,
      [userId],
    );
  });

  it("[roles] an unknown user id reads 'customer' (no row)", async () => {
    const reader = createRoleReader(pool);
    await expect(reader.getRole(randomUUID())).resolves.toBe("customer");
  });

  it("[roles] the DB CHECK rejects a role outside the closed set", async () => {
    await expect(
      pool.query(`update profiles set role = 'superuser' where id = $1`, [
        userId,
      ]),
    ).rejects.toThrow(/profiles_role_check/);
  });
});
