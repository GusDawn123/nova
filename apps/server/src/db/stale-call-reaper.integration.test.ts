import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStaleCallReaper } from "./stale-call-reaper.js";

/**
 * Stale-call reaper integration proof (adr-0006 §4 — closes the Phase 4
 * crash-mid-call orphan hole). A call that crashes before disposal never gets
 * `ended_at` stamped, so it is invisible to BOTH the RAG sweep and the notes
 * enqueue; this reaper stamps `ended_at` on meetings that are old-and-unfinished so
 * the normal machinery then picks them up. Self-skips unless the local stack env is
 * present.
 *
 * Concurrency: the reaper scans `meetings` GLOBALLY. To stay non-polluting and
 * deterministic under parallel suites, the test uses a threshold (1h) far larger
 * than any other suite's freshly-created rows and seeds its orphan 30 DAYS old — so
 * no recent foreign meeting is ever a candidate — and asserts on its OWN meeting
 * ids, never a global count.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

const silent = { info: () => undefined, error: () => undefined };

describe.skipIf(!hasStack)("stale-call reaper (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;
  let userId: string;

  const ONE_HOUR_MS = 3_600_000;

  // pg parses `timestamptz` into a JS Date; normalise to an ISO string so equality
  // checks compare values, not Date object identity.
  async function endedAt(meetingId: string): Promise<string | null> {
    const r = await pool.query<{ ended_at: Date | null }>(
      "select ended_at from meetings where id = $1",
      [meetingId],
    );
    const v = r.rows[0]?.ended_at ?? null;
    return v === null ? null : v.toISOString();
  }

  /** Insert a meeting with an explicit started_at + ended_at; returns its id. */
  async function seedMeeting(
    startedAtSql: string,
    endedAt: string | null,
  ): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title, started_at, ended_at)
       values ($1, $2, ${startedAtSql}, $3) returning id`,
      [userId, "stale reaper test", endedAt],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("no meeting id");
    return id;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    admin = createClient(url, serviceRoleKey, noPersist);
    const created = await admin.auth.admin.createUser({
      email: `stale-reaper-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    userId = created.data.user.id;
  });

  afterAll(async () => {
    await pool.query("delete from meetings where user_id = $1", [userId]);
    await admin.auth.admin.deleteUser(userId);
    await pool.end();
  });

  it("stamps ended_at only on the old orphan, never the fresh live call", async () => {
    const orphan = await seedMeeting("now() - interval '30 days'", null);
    const fresh = await seedMeeting("now()", null);

    const reaper = createStaleCallReaper({
      pool,
      logger: silent,
      config: { staleCallMaxAgeMs: ONE_HOUR_MS, staleReaperIntervalMs: 60_000 },
    });

    const stamped = await reaper.reapOnce();
    expect(stamped).toBeGreaterThanOrEqual(1);

    expect(await endedAt(orphan)).not.toBeNull(); // crashed call now finished
    expect(await endedAt(fresh)).toBeNull(); // a live call is left alone
  });

  it("is idempotent — a second pass never re-stamps an already-ended orphan", async () => {
    const orphan = await seedMeeting("now() - interval '30 days'", null);
    const reaper = createStaleCallReaper({
      pool,
      logger: silent,
      config: { staleCallMaxAgeMs: ONE_HOUR_MS, staleReaperIntervalMs: 60_000 },
    });

    await reaper.reapOnce();
    const firstStamp = await endedAt(orphan);
    expect(firstStamp).not.toBeNull();

    await reaper.reapOnce();
    expect(await endedAt(orphan)).toBe(firstStamp); // unchanged — not re-stamped
  });

  it("also skips soft-deleted orphans", async () => {
    const deletedOrphan = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title, started_at, ended_at, deleted_at)
       values ($1, 'deleted orphan', now() - interval '30 days', null, now())
       returning id`,
      [userId],
    );
    const id = deletedOrphan.rows[0]?.id;
    if (id === undefined) throw new Error("no id");

    const reaper = createStaleCallReaper({
      pool,
      logger: silent,
      config: { staleCallMaxAgeMs: ONE_HOUR_MS, staleReaperIntervalMs: 60_000 },
    });
    await reaper.reapOnce();

    expect(await endedAt(id)).toBeNull(); // soft-deleted → never resurrected
  });

  it("start()/stop() are exactly-once and safe to over-call", () => {
    const reaper = createStaleCallReaper({ pool, logger: silent });
    expect(() => {
      reaper.start();
      reaper.start();
      reaper.stop();
      reaper.stop();
    }).not.toThrow();
  });
});
