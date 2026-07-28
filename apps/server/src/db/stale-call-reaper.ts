import { Pool } from "pg";
import { z } from "zod";

import { notesConfig, type NotesConfig } from "../modules/notes/index.js";
import type { NotesLogger } from "../modules/notes/index.js";

/**
 * Stale-call reaper (adr-0006 §4) — the crash-safety net for the marker half of the
 * call lifecycle. `meetings.ended_at` is stamped only by the live session's disposal
 * (`markEnded`), so a crash mid-call leaves `ended_at` null forever and that meeting
 * is orphaned from BOTH the RAG indexer and the notes queue. This reaper stamps
 * `ended_at = now()` on any meeting that is live, unfinished, and older than
 * `staleCallMaxAgeMs` (default 6h) — the normal RAG sweep AND the notes sweep then
 * pick it up. It feeds both consumers, so it is wired in app.ts beside the RAG
 * indexer, not inside the notes worker.
 *
 * Lives in `db/` (direct `pg` Pool, explicit columns) so no SDK/Pool detail enters a
 * module. Idempotent (only stamps where `ended_at` is null), batch-capped, and logs
 * ids/counts only (RULES §6). Timer hygiene mirrors the RAG indexer / notes worker:
 * exactly-once start/stop, an overlapping-tick guard, `.unref()`.
 */

/** Default per-tick cap on how many orphans get stamped (bounds a large backlog). */
const DEFAULT_BATCH = 100;

/** The reaper handle: background lifecycle + a directly-drivable single pass (tests). */
export interface StaleCallReaper {
  start(): void;
  stop(): void;
  /** Run one pass; returns how many orphaned meetings were stamped ended. */
  reapOnce(): Promise<number>;
}

/** Construction dependencies. `config` defaults to the process-wide {@link notesConfig}. */
export interface StaleCallReaperDeps {
  readonly pool: Pool;
  readonly logger: NotesLogger;
  readonly config?: Pick<
    NotesConfig,
    "staleCallMaxAgeMs" | "staleReaperIntervalMs"
  >;
  /** Per-pass batch cap; defaults to {@link DEFAULT_BATCH}. */
  readonly batchSize?: number;
}

/** Stamp the oldest orphans first so a backlog drains in start order. $1 cutoff, $2 cap. */
const REAP_SQL = `
update meetings set ended_at = now()
where id in (
  select id from meetings
  where ended_at is null and deleted_at is null
    and coalesce(started_at, created_at) < $1
  order by coalesce(started_at, created_at) asc
  limit $2
)
returning id, user_id
`;

const reapedRowSchema = z.object({ id: z.string(), user_id: z.string() });

/** Build the {@link StaleCallReaper} over explicit deps (pure of env). */
export function createStaleCallReaper(
  deps: StaleCallReaperDeps,
): StaleCallReaper {
  const { pool, logger } = deps;
  const config = deps.config ?? notesConfig;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;

  let started = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function reapOnce(): Promise<number> {
    // Cutoff in JS so tests can seed deterministic ages without a clock dependency.
    const cutoff = new Date(
      Date.now() - config.staleCallMaxAgeMs,
    ).toISOString();
    const res = await pool.query(REAP_SQL, [cutoff, batchSize]);
    const rows = z.array(reapedRowSchema).parse(res.rows);
    if (rows.length > 0) {
      logger.info(
        { count: rows.length, meeting_ids: rows.map((r) => r.id) },
        "stale_call.reaped",
      );
    }
    return rows.length;
  }

  function tick(): void {
    if (running) return; // overlapping-tick guard
    running = true;
    void reapOnce()
      .catch((err: unknown) => {
        logger.error({ err }, "stale_call.reap_failed");
      })
      .finally(() => {
        running = false;
      });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      logger.info(
        {
          stale_reaper_interval_ms: config.staleReaperIntervalMs,
          stale_call_max_age_ms: config.staleCallMaxAgeMs,
        },
        "stale_call.reaper.started",
      );
      const id = setInterval(tick, config.staleReaperIntervalMs);
      id.unref();
      timer = id;
    },

    stop(): void {
      if (!started) return;
      started = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    reapOnce,
  };
}
