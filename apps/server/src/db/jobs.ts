import type { Pool } from "pg";
import { z } from "zod";

import {
  createResilientPool,
  PG_IDLE_TIMEOUT_MS,
  PG_POOL_MAX,
} from "./pg-pool.js";

/**
 * `NotesJobStore` — the durable notes-generation queue over a direct `pg` Pool
 * (adr-0006 §1, same house style as `modules/rag/adapters/pgvector.ts`: explicit
 * column lists, service-role/pool access, rows re-parsed at the boundary). This is
 * the ONLY place the notes worker + reapers talk to the `jobs` table.
 *
 * The queue drives execution; the product reads the denormalized
 * `meetings.notes_status` without ever joining `jobs` (adr §2). Every state
 * transition here that the product must observe also MIRRORS `notes_status`:
 *   - enqueue → 'queued'
 *   - claim   → 'processing'
 *   - fail / reap-to-dead → 'failed'
 * `complete()` deliberately does NOT flip `notes_status`: the 'completed' flip
 * happens in Task 4, atomically with the notes write, so a completed job whose notes
 * write failed can never masquerade as ready. `retry()` and reap-to-requeue leave
 * `notes_status='processing'` (still in flight; the next claim re-mirrors it).
 *
 * Delivery contract (adr §3): exactly-once CLAIM within a lease window (the single
 * atomic `UPDATE … FOR UPDATE SKIP LOCKED` below), at-least-once execution,
 * idempotent effects — multi-instance-safe from day one.
 */

const JOB_KIND = "generate_notes";

// ---------------------------------------------------------------------------
// Public contract (LOCKED — Tasks 4–5 compile against these).
// ---------------------------------------------------------------------------

/** A job handed to the worker after an atomic claim. */
export interface ClaimedJob {
  readonly id: string;
  readonly kind: "generate_notes";
  readonly meetingId: string;
  readonly userId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/** Per-attempt token usage recorded on the job row (the Phase 6 metering seam). */
export interface JobUsage {
  inputTokens?: number;
  outputTokens?: number;
  provider?: string;
}

export interface NotesJobStore {
  /** Insert a queued job for a meeting; idempotent under the partial unique index. */
  enqueue(
    meetingId: string,
    userId: string,
  ): Promise<"enqueued" | "already_active">;
  /** Atomically claim the oldest eligible queued job (SKIP LOCKED), attempts+1. */
  claim(workerId: string): Promise<ClaimedJob | null>;
  /** Terminal success: status→completed, record usage. Does NOT touch notes_status. */
  complete(jobId: string, usage: JobUsage[]): Promise<void>;
  /** Requeue with backoff: status→queued at `runAt`, attempts kept, lease cleared. */
  retry(jobId: string, error: string, runAt: Date): Promise<void>;
  /** Dead-letter: status→dead, keep raw model text, mirror notes_status='failed'. */
  fail(jobId: string, error: string, rawOutput?: string): Promise<void>;
  /** Reap expired leases: processing rows older than `leaseMs` → queued | dead. */
  reapExpired(leaseMs: number): Promise<number>;
  /** Backstop enqueue: ended+live+un-noted meetings with no active/completed job. */
  sweepEnqueue(limit: number): Promise<number>;
  /** Does this meeting already have a queued/processing generate_notes job? */
  hasActive(meetingId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Row schemas (the DB is a boundary too; RULES §1 — parse every one).
// ---------------------------------------------------------------------------

const claimedRowSchema = z.object({
  id: z.string(),
  kind: z.literal(JOB_KIND),
  meeting_id: z.string(),
  user_id: z.string(),
  attempts: z.number(),
  max_attempts: z.number(),
});

const enqueuedRowSchema = z.object({
  id: z.string(),
  meeting_id: z.string(),
  user_id: z.string(),
});

const failedRowSchema = z.object({
  meeting_id: z.string(),
  user_id: z.string(),
});

// ---------------------------------------------------------------------------
// SQL. Positional params documented per statement.
// ---------------------------------------------------------------------------

/**
 * The atomic claim (adr §1): ONE statement. The inner SELECT locks a single
 * eligible row with `FOR UPDATE SKIP LOCKED`, so two concurrent claims can never
 * grab the same row — the loser skips the locked row and picks the next (or none).
 * `run_at <= now()` respects backoff; oldest `run_at` first drains the backlog in
 * order. attempts+1 and the lease are stamped in the same write. $1 = workerId.
 */
const CLAIM_SQL = `
update jobs
set status = 'processing',
    attempts = attempts + 1,
    locked_at = now(),
    locked_by = $1,
    updated_at = now()
where id = (
  select id from jobs
  where status = 'queued' and kind = '${JOB_KIND}' and run_at <= now()
  order by run_at asc
  for update skip locked
  limit 1
)
returning id, kind, meeting_id, user_id, attempts, max_attempts
`;

/**
 * Sweep backstop (adr §4): enqueue for ended, live, never-noted meetings that have
 * no active AND no completed generate_notes job. `notes_status = 'none'` is the
 * primary guard — it excludes queued/processing/completed AND dead-lettered
 * ('failed') meetings, so a terminal dead job is never resurrected (adr §3). Oldest
 * `ended_at` first, capped at $1, idempotent under the partial unique index.
 */
const SWEEP_SQL = `
insert into jobs (kind, meeting_id, user_id)
select '${JOB_KIND}', m.id, m.user_id
from meetings m
where m.ended_at is not null
  and m.deleted_at is null
  and m.notes_status = 'none'
  and m.notes is null
  and not exists (
    select 1 from jobs j
    where j.kind = '${JOB_KIND}' and j.meeting_id = m.id
      and j.status in ('queued', 'processing', 'completed')
  )
order by m.ended_at asc
limit $1
on conflict (kind, meeting_id) where status in ('queued', 'processing')
  do nothing
returning meeting_id, user_id
`;

// ---------------------------------------------------------------------------
// Store factory.
// ---------------------------------------------------------------------------

/** Build a {@link NotesJobStore} over an explicit pool (pure of env). */
export function createNotesJobStore(pool: Pool): NotesJobStore {
  return {
    async enqueue(
      meetingId: string,
      userId: string,
    ): Promise<"enqueued" | "already_active"> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        // ON CONFLICT over the partial unique arbiter: a live (queued|processing)
        // job for this (kind, meeting) makes this a no-op → already_active.
        const inserted = await client.query(
          `insert into jobs (kind, meeting_id, user_id)
           values ('${JOB_KIND}', $1, $2)
           on conflict (kind, meeting_id) where status in ('queued', 'processing')
             do nothing
           returning id, meeting_id, user_id`,
          [meetingId, userId],
        );
        if (inserted.rowCount === 0) {
          await client.query("commit");
          return "already_active";
        }
        z.array(enqueuedRowSchema).parse(inserted.rows);
        await client.query(
          "update meetings set notes_status = 'queued' where id = $1 and user_id = $2",
          [meetingId, userId],
        );
        await client.query("commit");
        return "enqueued";
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async claim(workerId: string): Promise<ClaimedJob | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const res = await client.query(CLAIM_SQL, [workerId]);
        if (res.rowCount === 0) {
          await client.query("commit");
          return null;
        }
        const row = claimedRowSchema.parse(res.rows[0]);
        await client.query(
          "update meetings set notes_status = 'processing' where id = $1 and user_id = $2",
          [row.meeting_id, row.user_id],
        );
        await client.query("commit");
        return {
          id: row.id,
          kind: row.kind,
          meetingId: row.meeting_id,
          userId: row.user_id,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
        };
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async complete(jobId: string, usage: JobUsage[]): Promise<void> {
      // notes_status is intentionally untouched — Task 4 flips it to 'completed'
      // together with the notes write so the two can never disagree.
      await pool.query(
        `update jobs
         set status = 'completed', usage = $2::jsonb,
             locked_at = null, locked_by = null, updated_at = now()
         where id = $1`,
        [jobId, JSON.stringify(usage)],
      );
    },

    async retry(jobId: string, error: string, runAt: Date): Promise<void> {
      // attempts already incremented at claim time; kept here. notes_status stays
      // 'processing' (still in flight); the next claim re-mirrors it.
      await pool.query(
        `update jobs
         set status = 'queued', run_at = $3, last_error = $2,
             locked_at = null, locked_by = null, updated_at = now()
         where id = $1`,
        [jobId, error, runAt.toISOString()],
      );
    },

    async fail(
      jobId: string,
      error: string,
      rawOutput?: string,
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const res = await client.query(
          `update jobs
           set status = 'dead', last_error = $2, raw_output = $3,
               locked_at = null, locked_by = null, updated_at = now()
           where id = $1
           returning meeting_id, user_id`,
          [jobId, error, rawOutput ?? null],
        );
        if (res.rowCount !== 0) {
          const row = failedRowSchema.parse(res.rows[0]);
          await client.query(
            "update meetings set notes_status = 'failed' where id = $1 and user_id = $2",
            [row.meeting_id, row.user_id],
          );
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async reapExpired(leaseMs: number): Promise<number> {
      // Cutoff computed in JS so the test can force expiry deterministically without
      // a sleep (it backdates locked_at past the lease).
      const cutoff = new Date(Date.now() - leaseMs).toISOString();
      const client = await pool.connect();
      try {
        await client.query("begin");
        // Requeue expired leases that still have attempts left (attempts KEPT).
        const requeued = await client.query(
          `update jobs
           set status = 'queued', locked_at = null, locked_by = null,
               updated_at = now()
           where status = 'processing' and locked_at < $1
             and attempts < max_attempts`,
          [cutoff],
        );
        // Dead-letter expired leases at the attempt cap AND mirror notes_status.
        const dead = await client.query(
          `with reaped as (
             update jobs
             set status = 'dead',
                 last_error = coalesce(last_error, 'lease expired at attempt cap'),
                 locked_at = null, locked_by = null, updated_at = now()
             where status = 'processing' and locked_at < $1
               and attempts >= max_attempts
             returning meeting_id, user_id
           )
           update meetings m set notes_status = 'failed'
           from reaped r where m.id = r.meeting_id and m.user_id = r.user_id`,
          [cutoff],
        );
        await client.query("commit");
        return (requeued.rowCount ?? 0) + (dead.rowCount ?? 0);
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async sweepEnqueue(limit: number): Promise<number> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const res = await client.query(SWEEP_SQL, [limit]);
        const rows = z
          .array(enqueuedRowSchema.omit({ id: true }))
          .parse(res.rows);
        for (const row of rows) {
          await client.query(
            "update meetings set notes_status = 'queued' where id = $1 and user_id = $2",
            [row.meeting_id, row.user_id],
          );
        }
        await client.query("commit");
        return rows.length;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async hasActive(meetingId: string): Promise<boolean> {
      const res = await pool.query<{ active: boolean }>(
        `select exists (
           select 1 from jobs
           where kind = '${JOB_KIND}' and meeting_id = $1
             and status in ('queued', 'processing')
         ) as active`,
        [meetingId],
      );
      return res.rows[0]?.active ?? false;
    },
  };
}

// ---------------------------------------------------------------------------
// Env factory (lazy, memoised pool — mirrors pgVectorStoreFromEnv).
// ---------------------------------------------------------------------------

/** Re-parsed at this boundary (RULES §1), local to the adapter. */
const pgEnvSchema = z.object({ SUPABASE_DB_URL: z.string().url() });

/** Raised when the job store is asked for on a keyless (no DB URL) boot. */
export class JobStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStoreConfigError";
  }
}

/** Build a pool from env; throws {@link JobStoreConfigError} when unconfigured. */
export function createJobsPool(source: NodeJS.ProcessEnv = process.env): Pool {
  const parsed = pgEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new JobStoreConfigError(
      "Notes job store is not configured: set SUPABASE_DB_URL.",
    );
  }
  return createResilientPool(
    {
      connectionString: parsed.data.SUPABASE_DB_URL,
      max: PG_POOL_MAX,
      idleTimeoutMillis: PG_IDLE_TIMEOUT_MS,
    },
    "jobs",
  );
}

let cachedPool: Pool | undefined;

/** Presence check: is SUPABASE_DB_URL set + well-formed (so a feature can wire)? */
export function isJobStoreConfigured(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  return pgEnvSchema.safeParse(source).success;
}

/** Lazily build + memoise the pool and wrap it as a {@link NotesJobStore}. */
export function notesJobStoreFromEnv(source: NodeJS.ProcessEnv = process.env): {
  store: NotesJobStore;
  pool: Pool;
} {
  cachedPool ??= createJobsPool(source);
  return { store: createNotesJobStore(cachedPool), pool: cachedPool };
}
