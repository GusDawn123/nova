import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { UsageEventsDb } from "../modules/metering/ports.js";
import { createUsageEventsDb } from "./usage-events.js";

/**
 * `UsageEventsDb` integration proof — the ledger adapter's SQL (insert + the two
 * aggregates) runs against the LIVE local Supabase Postgres over the same direct `pg`
 * Pool the adapter uses (adr-0007 §1). Self-skips unless SUPABASE_DB_URL +
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are all present, so `npm run test` stays
 * green with the stack down.
 *
 * Concurrency note: `sumCostSince` scans usage_events GLOBALLY and other suites hit
 * the same DB in parallel. The global-sum case is therefore made immune to foreign
 * rows by using a FAR-FUTURE `since` no other suite writes past, and asserting on a
 * DELTA (after − before) rather than an absolute total. Users are minted via the
 * admin API (they must exist in auth.users for the profiles FK).
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

describe.skipIf(!hasStack)("UsageEventsDb (local stack)", () => {
  let pool: Pool;
  let db: UsageEventsDb;
  let admin: ReturnType<typeof createClient>;
  let userA: string;
  let userB: string;
  let meetingA: string;
  const userIds: string[] = [];

  async function createUser(): Promise<string> {
    const created = await admin.auth.admin.createUser({
      email: `usage-db-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    return created.data.user.id;
  }

  async function newMeeting(ownerId: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title) values ($1, $2) returning id`,
      [ownerId, "usage-events test meeting"],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    return id;
  }

  /** usage_events FK meetings + profiles (NO ACTION): delete usage first, then meetings,
   * then the auth user (cascades the profile). */
  async function purgeUser(id: string): Promise<void> {
    await pool.query(`delete from usage_events where user_id = $1`, [id]);
    await pool.query(`delete from meetings where user_id = $1`, [id]);
    await admin.auth.admin.deleteUser(id);
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) {
      throw new Error("Supabase stack env vars missing");
    }
    pool = new Pool({ connectionString: dbUrl });
    db = createUsageEventsDb(pool);
    admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    userA = await createUser();
    userIds.push(userA);
    userB = await createUser();
    userIds.push(userB);
    meetingA = await newMeeting(userA);
  });

  afterAll(async () => {
    for (const id of userIds) {
      await purgeUser(id);
    }
    await pool.end();
  });

  it("[insert] persists an llm event with the split + a priced cost", async () => {
    await db.insert({
      userId: userA,
      meetingId: meetingA,
      vendor: "openai",
      kind: "llm_tokens",
      amount: 1500,
      inputAmount: 1000,
      outputAmount: 500,
      model: "gpt-4o-mini",
      costEstimateUsd: 0.00045,
    });

    const row = await pool.query(
      `select user_id, meeting_id, vendor, kind, amount, input_amount,
              output_amount, model, cost_estimate_usd
       from usage_events where user_id = $1`,
      [userA],
    );
    expect(row.rowCount).toBe(1);
    const r = row.rows[0] as Record<string, unknown>;
    expect(r.vendor).toBe("openai");
    expect(r.meeting_id).toBe(meetingA);
    expect(Number(r.amount)).toBe(1500);
    expect(Number(r.input_amount)).toBe(1000);
    expect(Number(r.output_amount)).toBe(500);
    expect(r.model).toBe("gpt-4o-mini");
    expect(Number(r.cost_estimate_usd)).toBeCloseTo(0.00045, 8);
  });

  it("[insert] persists a non-llm event with null split + null meeting", async () => {
    await db.insert({
      userId: userB,
      vendor: "assemblyai",
      kind: "stt_seconds",
      amount: 90,
      costEstimateUsd: 0.00375,
    });

    const row = await pool.query(
      `select meeting_id, input_amount, output_amount, model
       from usage_events where user_id = $1`,
      [userB],
    );
    expect(row.rowCount).toBe(1);
    const r = row.rows[0] as Record<string, unknown>;
    expect(r.meeting_id).toBeNull();
    expect(r.input_amount).toBeNull();
    expect(r.output_amount).toBeNull();
    expect(r.model).toBeNull();
  });

  it("[sumAmountForUser] windows on `since` (inclusive) and scopes to user+kind", async () => {
    // Three llm rows for A at controlled timestamps: two inside a window, one before.
    const base = Date.now();
    const inside1 = new Date(base - 10 * 60_000); // 10 min ago
    const inside2 = new Date(base - 5 * 60_000); //  5 min ago
    const before = new Date(base - 60 * 60_000); //  1 h ago (outside)
    const since = new Date(base - 30 * 60_000); // 30 min ago

    for (const [amount, at] of [
      [100, inside1],
      [250, inside2],
      [999, before],
    ] as const) {
      await pool.query(
        `insert into usage_events (user_id, vendor, kind, amount, created_at)
         values ($1, 'openai', 'llm_tokens', $2, $3)`,
        [userB, amount, at.toISOString()],
      );
    }
    // A different kind inside the window must NOT be counted.
    await pool.query(
      `insert into usage_events (user_id, vendor, kind, amount, created_at)
       values ($1, 'assemblyai', 'stt_seconds', 7777, $2)`,
      [userB, inside2.toISOString()],
    );

    // Only the two llm rows at/after `since` count: 100 + 250 = 350. (The earlier
    // [stt_seconds] non-llm insert for userB is a different kind → excluded.)
    const sum = await db.sumAmountForUser(userB, "llm_tokens", since);
    expect(sum).toBe(350);

    // A boundary row exactly at `since` is included (created_at >= since).
    await pool.query(
      `insert into usage_events (user_id, vendor, kind, amount, created_at)
       values ($1, 'openai', 'llm_tokens', 1, $2)`,
      [userB, since.toISOString()],
    );
    const withBoundary = await db.sumAmountForUser(userB, "llm_tokens", since);
    expect(withBoundary).toBe(351);

    // Scoped to the user: A's rows never leak into B's sum.
    const aSum = await db.sumAmountForUser(userA, "stt_seconds", since);
    expect(aSum).toBe(0);
  });

  it("[sumCostSince] sums cost across ALL users in the window (global)", async () => {
    // A far-future baseline no other suite writes past → delta isolation.
    const since = new Date(Date.now() + 365 * 24 * 60 * 60_000);
    const before = await db.sumCostSince(since);

    await pool.query(
      `insert into usage_events (user_id, vendor, kind, amount, cost_estimate_usd, created_at)
       values ($1, 'openai', 'llm_tokens', 10, 1.25, $3),
              ($2, 'voyage', 'embedding_tokens', 20, 2.75, $3)`,
      [userA, userB, new Date(since.getTime() + 60_000).toISOString()],
    );

    const after = await db.sumCostSince(since);
    // 1.25 (A) + 2.75 (B) = 4.00 added, across both users.
    expect(after - before).toBeCloseTo(4.0, 8);
  });
});
