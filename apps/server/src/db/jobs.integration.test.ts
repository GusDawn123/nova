import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createNotesJobStore, type NotesJobStore } from "./jobs.js";
import { createTranscriptPersister } from "./transcripts.js";

/**
 * `NotesJobStore` integration proof — the durable queue's SQL runs against the
 * LIVE local Supabase Postgres over the same direct `pg` Pool the adapter uses
 * (adr-0006 §1). Self-skips unless SUPABASE_DB_URL + SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY are all present, so `npm run test` stays green with the
 * stack down.
 *
 * Concurrency note: `claim`/`sweepEnqueue` scan the jobs table GLOBALLY, and other
 * integration suites hit the same DB in parallel. Every test here is made immune to
 * — and non-polluting of — foreign rows by (a) BACKDATING its own rows (`run_at`,
 * `locked_at`, `ended_at`) so they sort first in the claim/sweep order, and
 * (b) asserting on its OWN job/meeting ids rather than global counts. Users are
 * minted via the admin API (they must exist in auth.users for the profiles FK).
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)("NotesJobStore (local stack)", () => {
  let pool: Pool;
  let store: NotesJobStore;
  let admin: ReturnType<typeof createClient>;
  let userId: string;
  const userIds: string[] = [];

  async function createUser(): Promise<string> {
    const created = await admin.auth.admin.createUser({
      email: `jobs-store-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    return created.data.user.id;
  }

  /** Insert a meeting owned by `userId`; returns its id. */
  async function newMeeting(
    opts: {
      endedAt?: string | null;
      startedAt?: string | null;
      notesStatus?: string;
      deletedAt?: string | null;
    } = {},
  ): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into meetings (user_id, title, started_at, ended_at, notes_status, deleted_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        userId,
        "jobs store test meeting",
        opts.startedAt ?? null,
        opts.endedAt ?? null,
        opts.notesStatus ?? "none",
        opts.deletedAt ?? null,
      ],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("meeting insert returned no id");
    return id;
  }

  interface JobRow {
    id: string;
    status: string;
    attempts: number;
    max_attempts: number;
    locked_at: string | null;
    locked_by: string | null;
    last_error: string | null;
    raw_output: string | null;
    usage: unknown;
    run_at: string;
  }

  async function readJob(id: string): Promise<JobRow> {
    const r = await pool.query<JobRow>(
      `select id, status, attempts, max_attempts, locked_at, locked_by,
              last_error, raw_output, usage, run_at
       from jobs where id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error(`no job ${id}`);
    return row;
  }

  async function notesStatus(meetingId: string): Promise<string> {
    const r = await pool.query<{ notes_status: string }>(
      "select notes_status from meetings where id = $1",
      [meetingId],
    );
    return r.rows[0]?.notes_status ?? "";
  }

  async function activeJobId(meetingId: string): Promise<string | null> {
    const r = await pool.query<{ id: string }>(
      `select id from jobs where meeting_id = $1
         and status in ('queued', 'processing') limit 1`,
      [meetingId],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Make a job the oldest in the claim/sweep order so it is picked deterministically. */
  async function backdateRunAt(jobId: string): Promise<void> {
    await pool.query(
      "update jobs set run_at = now() - interval '1 day' where id = $1",
      [jobId],
    );
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 6 });
    store = createNotesJobStore(pool);
    admin = createClient(url, serviceRoleKey, noPersist);
    userId = await createUser();
    userIds.push(userId);
  });

  // Each test starts from a clean jobs slate FOR MY USER (scoped by user_id, so
  // foreign suites are untouched). This makes the GLOBAL `claim` deterministic: my
  // backdated job is then the only old queued row I own, and it sorts ahead of any
  // foreign row created "now".
  beforeEach(async () => {
    await pool.query("delete from jobs where user_id = $1", [userId]);
  });

  afterAll(async () => {
    for (const id of userIds) {
      await pool.query("delete from jobs where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  it("[enqueue] inserts a job, mirrors notes_status='queued', and is idempotent", async () => {
    const meetingId = await newMeeting();

    expect(await store.enqueue(meetingId, userId)).toBe("enqueued");
    expect(await notesStatus(meetingId)).toBe("queued");
    const first = await activeJobId(meetingId);
    expect(first).not.toBeNull();

    // Second enqueue collides with the partial unique index → already_active, no
    // second active row.
    expect(await store.enqueue(meetingId, userId)).toBe("already_active");
    expect(await activeJobId(meetingId)).toBe(first);
  });

  it("[claim] atomically moves queued→processing, attempts+1, sets lease + mirror", async () => {
    const meetingId = await newMeeting();
    await store.enqueue(meetingId, userId);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    await backdateRunAt(jobId); // oldest → this claim picks it over foreign rows

    const claimed = await store.claim("worker-a");
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.kind).toBe("generate_notes");
    expect(claimed?.meetingId).toBe(meetingId);
    expect(claimed?.userId).toBe(userId);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.maxAttempts).toBe(5);

    const row = await readJob(jobId);
    expect(row.status).toBe("processing");
    expect(row.attempts).toBe(1);
    expect(row.locked_by).toBe("worker-a");
    expect(row.locked_at).not.toBeNull();
    expect(await notesStatus(meetingId)).toBe("processing");
  });

  it("[claim-race] two concurrent claims of one job → exactly one winner", async () => {
    const meetingId = await newMeeting();
    await store.enqueue(meetingId, userId);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    await backdateRunAt(jobId); // oldest → both claims target THIS job first

    const [a, b] = await Promise.all([
      store.claim("racer-1"),
      store.claim("racer-2"),
    ]);

    // Exactly one of MY two claims won MY job (SKIP LOCKED). The loser skipped the
    // locked row and got null or an unrelated foreign job — never my job twice.
    const winners = [a, b].filter((c) => c?.id === jobId);
    expect(winners).toHaveLength(1);
    expect(a?.id !== b?.id || (a === null && b === null)).toBe(true);
  });

  it("[complete] sets status='completed' + usage; does NOT touch notes_status (Task 4 owns the flip)", async () => {
    const meetingId = await newMeeting();
    await store.enqueue(meetingId, userId);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    await backdateRunAt(jobId);
    await store.claim("worker-c");

    await store.complete(jobId, [
      { inputTokens: 100, outputTokens: 20, provider: "anthropic" },
    ]);

    const row = await readJob(jobId);
    expect(row.status).toBe("completed");
    expect(row.locked_at).toBeNull();
    expect(row.usage).toEqual([
      { inputTokens: 100, outputTokens: 20, provider: "anthropic" },
    ]);
    // complete() deliberately leaves notes_status at 'processing'; Task 4 flips it to
    // 'completed' together with the notes write.
    expect(await notesStatus(meetingId)).toBe("processing");
  });

  it("[retry] requeues with a future run_at, keeps attempts, records last_error", async () => {
    const meetingId = await newMeeting();
    await store.enqueue(meetingId, userId);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    await backdateRunAt(jobId);
    await store.claim("worker-r");

    const runAt = new Date(Date.now() + 60_000);
    await store.retry(jobId, "429 rate limited", runAt);

    const row = await readJob(jobId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1); // kept from the claim
    expect(row.locked_at).toBeNull();
    expect(row.last_error).toBe("429 rate limited");
    expect(new Date(row.run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("[fail] dead-letters, stores raw_output, mirrors notes_status='failed'", async () => {
    const meetingId = await newMeeting();
    await store.enqueue(meetingId, userId);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    await backdateRunAt(jobId);
    await store.claim("worker-f");

    await store.fail(jobId, "permanent boom", "{ not json");

    const row = await readJob(jobId);
    expect(row.status).toBe("dead");
    expect(row.last_error).toBe("permanent boom");
    expect(row.raw_output).toBe("{ not json");
    expect(row.locked_at).toBeNull();
    expect(await notesStatus(meetingId)).toBe("failed");
  });

  it("[reap-requeue] an expired processing job with attempts left → queued, attempts kept", async () => {
    const meetingId = await newMeeting();
    await store.enqueue(meetingId, userId);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    // Model a crashed worker's claim directly (attempts=1) with a lease backdated
    // past expiry — deterministic, no sleep, no dependence on the global claim.
    await pool.query(
      `update jobs set status = 'processing', attempts = 1, locked_by = 'dead-worker',
         locked_at = now() - interval '1 hour' where id = $1`,
      [jobId],
    );

    const reaped = await store.reapExpired(60_000); // lease 60s → 1h-old lock expired
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = await readJob(jobId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1); // KEPT
    expect(row.locked_at).toBeNull();
    expect(row.locked_by).toBeNull();
  });

  it("[reap-dead] an expired processing job at the attempt cap → dead + notes_status='failed'", async () => {
    const meetingId = await newMeeting();
    await store.enqueue(meetingId, userId);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    // Model the last attempt already in flight: processing, attempts == max, lease
    // expired.
    await pool.query(
      `update jobs set status = 'processing', attempts = max_attempts,
         locked_by = 'dead-worker', locked_at = now() - interval '1 hour'
       where id = $1`,
      [jobId],
    );

    const reaped = await store.reapExpired(60_000);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = await readJob(jobId);
    expect(row.status).toBe("dead");
    expect(row.locked_at).toBeNull();
    expect(await notesStatus(meetingId)).toBe("failed");
  });

  it("[hasActive] true for a queued/processing job, false once terminal", async () => {
    const meetingId = await newMeeting();
    expect(await store.hasActive(meetingId)).toBe(false);
    await store.enqueue(meetingId, userId);
    expect(await store.hasActive(meetingId)).toBe(true);
    const jobId = await activeJobId(meetingId);
    if (jobId === null) throw new Error("no job");
    await backdateRunAt(jobId);
    await store.claim("worker-h");
    expect(await store.hasActive(meetingId)).toBe(true);
    await store.complete(jobId, []);
    expect(await store.hasActive(meetingId)).toBe(false);
  });

  it("[sweep] enqueues an eligible ended+live+un-noted meeting; skips excluded ones", async () => {
    const old = (days: number): string =>
      new Date(Date.now() - days * 86_400_000).toISOString();

    // The ONE eligible meeting. All excluded meetings below are made OLDER so that,
    // with limit=1 and ended_at-asc order, any exclusion leak would steal the slot
    // from `eligible` — the assertion then fails, making this a real detector.
    const eligible = await newMeeting({
      endedAt: old(30),
      notesStatus: "none",
    });

    const withCompleted = await newMeeting({ endedAt: old(40) });
    await pool.query(
      `insert into jobs (kind, meeting_id, user_id, status) values ('generate_notes', $1, $2, 'completed')`,
      [withCompleted, userId],
    );
    const withActive = await newMeeting({ endedAt: old(39) });
    await store.enqueue(withActive, userId);
    const alreadyNoted = await newMeeting({
      endedAt: old(38),
      notesStatus: "completed",
    });
    const deleted = await newMeeting({
      endedAt: old(37),
      deletedAt: new Date().toISOString(),
    });
    const notEnded = await newMeeting({ startedAt: old(36), endedAt: null });

    const n = await store.sweepEnqueue(1);
    expect(n).toBe(1);

    expect(await activeJobId(eligible)).not.toBeNull();
    expect(await notesStatus(eligible)).toBe("queued");
    // withActive still has exactly its original single active job (not doubled).
    const activeCount = await pool.query<{ c: number }>(
      "select count(*)::int as c from jobs where meeting_id = $1 and status in ('queued','processing')",
      [withActive],
    );
    expect(activeCount.rows[0]?.c).toBe(1);
    // The excluded meetings got no active job from the sweep.
    for (const m of [alreadyNoted, deleted, notEnded]) {
      expect(await activeJobId(m)).toBeNull();
    }
    // withCompleted keeps only its completed history — no fresh active job.
    expect(await activeJobId(withCompleted)).toBeNull();
  });

  it("[eager-enqueue seam] markEnded fires onEnded once; a second disposal never double-enqueues", async () => {
    const meetingId = await newMeeting({ startedAt: new Date().toISOString() });

    const enqueues: Promise<unknown>[] = [];
    let onEndedCalls = 0;
    const persister = createTranscriptPersister({
      onEnded: (m, u) => {
        onEndedCalls += 1;
        enqueues.push(store.enqueue(m, u));
      },
    });

    await persister.markEnded(meetingId, userId); // stamps ended_at → fires onEnded
    await persister.markEnded(meetingId, userId); // already ended → no stamp, no fire
    await Promise.all(enqueues);

    expect(onEndedCalls).toBe(1);
    const jobs = await pool.query<{ c: number }>(
      "select count(*)::int as c from jobs where meeting_id = $1",
      [meetingId],
    );
    expect(jobs.rows[0]?.c).toBe(1);
  });
});
