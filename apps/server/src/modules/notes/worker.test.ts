import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createNotesJobStore, type NotesJobStore } from "../../db/jobs.js";
import type { ClaimedJob, JobUsage } from "../../db/jobs.js";
import { createNotesWorker } from "./worker.js";
import type { NotesJobHandler, NotesLogger } from "./ports.js";

/** Silent logger — the worker logs ids/counts, irrelevant to these assertions. */
const silent: NotesLogger = { info: () => undefined, error: () => undefined };

/** A claimable job fixture. */
function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: overrides.id ?? "job-1",
    kind: "generate_notes",
    meetingId: overrides.meetingId ?? "meeting-1",
    userId: overrides.userId ?? "user-1",
    attempts: overrides.attempts ?? 1,
    maxAttempts: overrides.maxAttempts ?? 5,
  };
}

interface RetryCall {
  jobId: string;
  error: string;
  runAt: Date;
}
interface FailCall {
  jobId: string;
  error: string;
  rawOutput?: string;
}

/** In-memory {@link NotesJobStore} recording the worker's transitions. */
class FakeStore implements NotesJobStore {
  queued: ClaimedJob[] = [];
  claimCalls = 0;
  completeCalls: { jobId: string; usage: JobUsage[] }[] = [];
  retryCalls: RetryCall[] = [];
  failCalls: FailCall[] = [];
  reapCalls: number[] = [];
  sweepCalls: number[] = [];
  reapReturns = 0;
  sweepReturns = 0;
  /** When set, `claim` awaits this before resolving — models a slow in-flight tick. */
  claimGate: Promise<void> | null = null;

  enqueue(): Promise<"enqueued" | "already_active"> {
    return Promise.resolve("enqueued");
  }
  async claim(): Promise<ClaimedJob | null> {
    this.claimCalls += 1;
    if (this.claimGate !== null) await this.claimGate;
    return this.queued.shift() ?? null;
  }
  complete(jobId: string, usage: JobUsage[]): Promise<void> {
    this.completeCalls.push({ jobId, usage });
    return Promise.resolve();
  }
  retry(jobId: string, error: string, runAt: Date): Promise<void> {
    this.retryCalls.push({ jobId, error, runAt });
    return Promise.resolve();
  }
  fail(jobId: string, error: string, rawOutput?: string): Promise<void> {
    this.failCalls.push({ jobId, error, ...(rawOutput !== undefined ? { rawOutput } : {}) });
    return Promise.resolve();
  }
  reapExpired(leaseMs: number): Promise<number> {
    this.reapCalls.push(leaseMs);
    return Promise.resolve(this.reapReturns);
  }
  sweepEnqueue(limit: number): Promise<number> {
    this.sweepCalls.push(limit);
    return Promise.resolve(this.sweepReturns);
  }
  hasActive(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** A handler that always yields a fixed outcome. */
function fixedHandler(
  outcome: Awaited<ReturnType<NotesJobHandler["handle"]>>,
): NotesJobHandler {
  return { handle: () => Promise.resolve(outcome) };
}

describe("createNotesWorker — outcome mapping (tickOnce)", () => {
  it("completed → store.complete(usage), returns 1", async () => {
    const store = new FakeStore();
    store.queued.push(job());
    const usage: JobUsage[] = [{ inputTokens: 10, provider: "openai" }];
    const worker = createNotesWorker({
      store,
      handler: fixedHandler({ outcome: "completed", usage }),
      logger: silent,
    });

    expect(await worker.tickOnce()).toBe(1);
    expect(store.completeCalls).toEqual([{ jobId: "job-1", usage }]);
    expect(store.retryCalls).toHaveLength(0);
    expect(store.failCalls).toHaveLength(0);
  });

  it("retry (attempts < max) → store.retry with a FUTURE run_at (backoff applied)", async () => {
    const store = new FakeStore();
    store.queued.push(job({ attempts: 1, maxAttempts: 5 }));
    const worker = createNotesWorker({
      store,
      handler: fixedHandler({ outcome: "retry", error: "429" }),
      logger: silent,
    });

    const before = Date.now();
    expect(await worker.tickOnce()).toBe(1);
    expect(store.retryCalls).toHaveLength(1);
    expect(store.retryCalls[0]?.error).toBe("429");
    expect(store.retryCalls[0]?.runAt.getTime()).toBeGreaterThan(before);
    expect(store.failCalls).toHaveLength(0);
  });

  it("retry AT the attempt cap → dead-letter (store.fail), never re-queued", async () => {
    const store = new FakeStore();
    store.queued.push(job({ attempts: 5, maxAttempts: 5 }));
    const worker = createNotesWorker({
      store,
      handler: fixedHandler({ outcome: "retry", error: "still 429" }),
      logger: silent,
    });

    expect(await worker.tickOnce()).toBe(1);
    expect(store.retryCalls).toHaveLength(0);
    expect(store.failCalls).toEqual([{ jobId: "job-1", error: "still 429" }]);
  });

  it("failed → store.fail(error, rawOutput)", async () => {
    const store = new FakeStore();
    store.queued.push(job());
    const worker = createNotesWorker({
      store,
      handler: fixedHandler({
        outcome: "failed",
        error: "ladder exhausted",
        rawOutput: "{bad",
      }),
      logger: silent,
    });

    expect(await worker.tickOnce()).toBe(1);
    expect(store.failCalls).toEqual([
      { jobId: "job-1", error: "ladder exhausted", rawOutput: "{bad" },
    ]);
  });

  it("a thrown handler is treated as a transient retry (at-least-once)", async () => {
    const store = new FakeStore();
    store.queued.push(job({ attempts: 1, maxAttempts: 5 }));
    const worker = createNotesWorker({
      store,
      handler: { handle: () => Promise.reject(new Error("boom")) },
      logger: silent,
    });

    expect(await worker.tickOnce()).toBe(1);
    expect(store.retryCalls).toHaveLength(1);
    expect(store.retryCalls[0]?.error).toContain("boom");
  });

  it("no queued job → returns 0, handler never runs", async () => {
    const store = new FakeStore();
    let handled = 0;
    const worker = createNotesWorker({
      store,
      handler: { handle: () => { handled += 1; return Promise.resolve({ outcome: "completed", usage: [] }); } },
      logger: silent,
    });

    expect(await worker.tickOnce()).toBe(0);
    expect(handled).toBe(0);
  });
});

describe("createNotesWorker — lifecycle & timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() polls at pollIntervalMs and reaps at reaperIntervalMs; exactly-once", async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    const worker = createNotesWorker({
      store,
      handler: fixedHandler({ outcome: "completed", usage: [] }),
      logger: silent,
      config: { pollIntervalMs: 1_000, reaperIntervalMs: 5_000, leaseMs: 42, sweepBatchSize: 7 },
    });

    worker.start();
    worker.start(); // exactly-once: no second set of timers

    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.claimCalls).toBe(1); // one poll, not two

    await vi.advanceTimersByTimeAsync(4_000); // reaches the 5s reaper tick
    expect(store.reapCalls).toEqual([42]); // reaper uses the configured lease
    expect(store.sweepCalls).toEqual([7]); // and hosts the sweep backstop

    worker.stop();
    const claimsAtStop = store.claimCalls;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.claimCalls).toBe(claimsAtStop); // stopped → no more ticks
  });

  it("guards against overlapping poll ticks (a slow tick skips the next)", async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    let release = (): void => undefined;
    store.claimGate = new Promise<void>((r) => {
      release = r;
    });
    const worker = createNotesWorker({
      store,
      handler: fixedHandler({ outcome: "completed", usage: [] }),
      logger: silent,
      config: { pollIntervalMs: 1_000 },
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(1_000); // tick 1 starts, claim pending
    await vi.advanceTimersByTimeAsync(1_000); // tick 2 fires but is guarded → skipped
    expect(store.claimCalls).toBe(1);

    release();
    worker.stop();
  });
});

// ---------------------------------------------------------------------------
// Kill-mid-processing recovery — the adr §3 playbook bar, against the LIVE stack.
// ---------------------------------------------------------------------------

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)("createNotesWorker — recovery (local stack)", () => {
  let pool: Pool;
  let store: NotesJobStore;
  let admin: ReturnType<typeof createClient>;
  let userId: string;

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    store = createNotesJobStore(pool);
    admin = createClient(url, serviceRoleKey, noPersist);
    const created = await admin.auth.admin.createUser({
      email: `notes-worker-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    userId = created.data.user.id;
    await pool.query("delete from jobs where user_id = $1", [userId]);
  });

  afterAll(async () => {
    await pool.query("delete from jobs where user_id = $1", [userId]);
    await pool.query("delete from meetings where user_id = $1", [userId]);
    await admin.auth.admin.deleteUser(userId);
    await pool.end();
  });

  it("requeues a job whose worker died mid-processing; a fresh worker completes it", async () => {
    const m = await pool.query<{ id: string }>(
      "insert into meetings (user_id, title, ended_at) values ($1, $2, now()) returning id",
      [userId, "recovery meeting"],
    );
    const meetingId = m.rows[0]?.id;
    if (meetingId === undefined) throw new Error("no meeting");

    await store.enqueue(meetingId, userId);

    // A worker claims the job, then DIES before completing (no complete/retry). Model
    // the death by claiming, then backdating the lease well past expiry. run_at is
    // pushed far into the past so the requeued job is the oldest globally and a fresh
    // worker's claim deterministically picks it.
    const claimed = await store.claim("crashed-worker");
    expect(claimed?.meetingId).toBe(meetingId);
    await pool.query(
      `update jobs set locked_at = now() - interval '1 hour',
         run_at = now() - interval '2 days' where id = $1`,
      [claimed?.id ?? ""],
    );

    // The reaper (tiny lease) requeues the expired job, attempts kept.
    expect(await store.reapExpired(1_000)).toBeGreaterThanOrEqual(1);

    // A fresh worker picks up the requeued job and completes it — no lost meeting.
    const worker = createNotesWorker({
      store,
      handler: fixedHandler({ outcome: "completed", usage: [{ provider: "test" }] }),
      logger: silent,
      workerId: "fresh-worker",
    });
    expect(await worker.tickOnce()).toBe(1);

    const row = await pool.query<{ status: string; attempts: number }>(
      "select status, attempts from jobs where id = $1",
      [claimed?.id ?? ""],
    );
    expect(row.rows[0]?.status).toBe("completed");
    expect(row.rows[0]?.attempts).toBe(2); // 1 (crashed) + 1 (recovery claim)
  });
});
