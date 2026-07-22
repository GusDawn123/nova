import { randomUUID } from "node:crypto";

import type { ClaimedJob, NotesJobStore } from "../../db/jobs.js";

import {
  computeBackoff,
  notesConfigSchema,
  type NotesConfig,
} from "./config.js";
import type { NotesJobHandler, NotesLogger, NotesWorker } from "./ports.js";

/**
 * The notes worker (adr-0006 §3) — a poll loop that atomically claims one job per
 * tick and delegates it to a {@link NotesJobHandler}, plus a reaper loop that
 * recovers crashed jobs (lease expiry) and runs the sweep backstop. Generic over
 * the handler: Task 4 plugs the real pipeline in; Task 2 tests use a fake.
 *
 * Timer hygiene + exactly-once start/stop mirror the RAG indexer (`modules/rag/
 * indexer.ts`): plain setInterval/clearInterval, an overlapping-tick guard per loop,
 * and `.unref()` so background work never holds the process open during shutdown.
 * At-least-once execution: the handler's effects are idempotent (Task 4), so a
 * re-run after a lease-expiry requeue costs tokens, not correctness.
 */

/** Construction dependencies. `config` is a partial override of the module defaults. */
export interface NotesWorkerDeps {
  readonly store: NotesJobStore;
  readonly handler: NotesJobHandler;
  readonly logger: NotesLogger;
  readonly config?: Partial<NotesConfig>;
  /** Lease owner id; a random one is minted when omitted. */
  readonly workerId?: string;
  /**
   * The global daily-spend kill-switch (Phase 6, adr-0007 §5), gating the CLAIM
   * itself: tripped → the tick returns without touching the store, so no
   * attempts are burned and queued jobs simply wait out the day (nothing lost,
   * nothing dead-letters); in-flight jobs finish (the gate is per-tick, never
   * mid-job). Optional (keyless posture) and fail-open on an internal failure.
   */
  readonly isDailyCapReached?: () => Promise<boolean>;
}

/** Best-effort message from an unknown thrown value (never leaks a stack to logs). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the {@link NotesWorker} over explicit deps (pure of env — app.ts wires prod). */
export function createNotesWorker(deps: NotesWorkerDeps): NotesWorker {
  const { store, handler, logger } = deps;
  const config = notesConfigSchema.parse(deps.config ?? {});
  const workerId = deps.workerId ?? `notes-${randomUUID()}`;

  let started = false;
  let polling = false;
  let reaping = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reaperTimer: ReturnType<typeof setInterval> | null = null;

  /** Map one claimed job's handler outcome onto a store transition. */
  async function processOne(job: ClaimedJob): Promise<void> {
    const base = {
      worker_id: workerId,
      job_id: job.id,
      meeting_id: job.meetingId,
    };

    let outcome: Awaited<ReturnType<NotesJobHandler["handle"]>>;
    try {
      outcome = await handler.handle(job);
    } catch (err) {
      // A thrown handler is transient by contract (the pipeline never throws for
      // content reasons) → retry, at-least-once.
      outcome = { outcome: "retry", error: errorMessage(err) };
    }

    switch (outcome.outcome) {
      case "completed":
        await store.complete(job.id, outcome.usage);
        logger.info(
          { ...base, usage: outcome.usage.length },
          "notes.job.completed",
        );
        return;
      case "retry":
        if (job.attempts >= job.maxAttempts) {
          // Exhausted: a retry at the cap becomes a dead-letter (adr §3).
          await store.fail(job.id, outcome.error);
          logger.info({ ...base, attempts: job.attempts }, "notes.job.dead");
          return;
        }
        {
          const delayMs = computeBackoff(job.attempts, config);
          await store.retry(
            job.id,
            outcome.error,
            new Date(Date.now() + delayMs),
          );
          logger.info(
            { ...base, attempts: job.attempts, delay_ms: delayMs },
            "notes.job.retry",
          );
        }
        return;
      case "failed":
        await store.fail(job.id, outcome.error, outcome.rawOutput);
        logger.info(base, "notes.job.failed");
        return;
      default: {
        // Exhaustive: a new outcome arm breaks the build until it is handled.
        const never: never = outcome;
        throw new Error(`unhandled notes outcome: ${JSON.stringify(never)}`);
      }
    }
  }

  async function tickOnce(): Promise<number> {
    // Daily-cap claim gate (see deps doc). Fail OPEN: the kill-switch logs its
    // own failure loudly; a broken sum must not stall the queue.
    if (deps.isDailyCapReached) {
      let capReached = false;
      try {
        capReached = await deps.isDailyCapReached();
      } catch (err) {
        logger.error(
          { worker_id: workerId, err },
          "notes.daily_cap_check_failed",
        );
      }
      if (capReached) return 0;
    }
    const claimed = await store.claim(workerId);
    if (claimed === null) return 0;
    await processOne(claimed);
    return 1;
  }

  function pollTick(): void {
    if (polling) return; // overlapping-tick guard: a slow job must not stack ticks
    polling = true;
    void tickOnce()
      .catch((err: unknown) => {
        logger.error({ worker_id: workerId, err }, "notes.poll_failed");
      })
      .finally(() => {
        polling = false;
      });
  }

  function reaperTick(): void {
    if (reaping) return;
    reaping = true;
    void (async () => {
      // Lease recovery + the enqueue backstop share this tick (adr §4).
      const requeued = await store.reapExpired(config.leaseMs);
      const swept = await store.sweepEnqueue(config.sweepBatchSize);
      if (requeued > 0 || swept > 0) {
        logger.info(
          { worker_id: workerId, reaped: requeued, swept },
          "notes.reaper.tick",
        );
      }
    })()
      .catch((err: unknown) => {
        logger.error({ worker_id: workerId, err }, "notes.reaper_failed");
      })
      .finally(() => {
        reaping = false;
      });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      logger.info(
        {
          worker_id: workerId,
          poll_interval_ms: config.pollIntervalMs,
          reaper_interval_ms: config.reaperIntervalMs,
          lease_ms: config.leaseMs,
        },
        "notes.worker.started",
      );
      const poll = setInterval(pollTick, config.pollIntervalMs);
      const reap = setInterval(reaperTick, config.reaperIntervalMs);
      poll.unref();
      reap.unref();
      pollTimer = poll;
      reaperTimer = reap;
    },

    stop(): void {
      if (!started) return;
      started = false;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (reaperTimer !== null) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }
    },

    tickOnce,
  };
}
