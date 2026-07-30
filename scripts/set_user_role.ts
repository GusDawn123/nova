import { Pool } from "pg";
import { z } from "zod";

/**
 * set_user_role — assign a permission role to a user (adr-0008).
 *
 * Usage (repo root; the local stack must be up):
 *   npx tsx scripts/set_user_role.ts <email|user-uuid> <developer|admin|customer>
 *
 * Connects over SUPABASE_DB_URL (service-level — role writes are deliberately
 * NOT possible with a user JWT; see migration 20260723100000). When the var is
 * absent, falls back to loading `apps/server/.env` (Node's built-in loader) so
 * the common local invocation needs no manual export. Resolves an email via
 * `auth.users`; validates the role against the closed set BEFORE touching the
 * DB; idempotent — re-running with the same role is a no-op that still reports.
 */

const roleArgSchema = z.enum(["developer", "admin", "customer"]);
const uuidSchema = z.string().uuid();

/**
 * The whole CLI boundary as ONE schema (RULES §1: zod-parse every boundary —
 * argv is one). A tuple rejects both too few and too many arguments, so arity,
 * identifier shape and role membership are decided in a single parse rather than
 * by a hand-rolled truthiness check followed by a partial safeParse.
 *
 * The identifier is validated as email-or-uuid up front. Previously any non-empty
 * string was accepted and a typo only surfaced as "no auth user found" AFTER
 * opening a pool and querying auth.users.
 */
const cliArgsSchema = z.tuple([
  z.union([z.string().email(), uuidSchema], {
    errorMap: () => ({ message: "identifier must be an email or a user uuid" }),
  }),
  roleArgSchema,
]);

function fail(message: string): never {
  console.error(`set_user_role: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = cliArgsSchema.safeParse(process.argv.slice(2));
  if (!parsed.success) {
    // Lead with the usage line — it is what the operator actually needs — then
    // the specific complaint, so a wrong role still names the allowed set.
    fail(
      [
        "usage: npx tsx scripts/set_user_role.ts <email|user-uuid> <developer|admin|customer>",
        ...parsed.error.issues.map((issue) => `  - ${issue.message}`),
        `  allowed roles: ${roleArgSchema.options.join(", ")}`,
      ].join("\n"),
    );
  }
  const [identifier, role] = parsed.data;

  if (!process.env.SUPABASE_DB_URL) {
    try {
      process.loadEnvFile("apps/server/.env");
    } catch {
      // fall through to the explicit check below
    }
  }
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    fail(
      "SUPABASE_DB_URL is not set (and apps/server/.env did not provide it) — is the local stack up?",
    );
  }

  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    // Resolve email → uuid via auth.users when the identifier is not a uuid.
    let userId = identifier;
    if (!uuidSchema.safeParse(identifier).success) {
      const found = await pool.query<{ id: string }>(
        `select id from auth.users where email = $1`,
        [identifier.toLowerCase()],
      );
      const row = found.rows[0];
      if (!row) fail(`no auth user found for email "${identifier}"`);
      userId = row.id;
    }

    const before = await pool.query<{ role: string }>(
      `select role from profiles where id = $1 and deleted_at is null`,
      [userId],
    );
    const current = before.rows[0]?.role;
    if (current === undefined) {
      fail(`no live profile row for user ${userId}`);
    }

    if (current === role) {
      console.log(`user ${userId} already has role '${role}' — no change`);
      return;
    }

    const updated = await pool.query(
      `update profiles set role = $1 where id = $2 and deleted_at is null`,
      [role, userId],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      fail(`update touched ${String(updated.rowCount ?? 0)} rows — aborting`);
    }
    console.log(`user ${userId}: role '${current}' -> '${role}'`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
