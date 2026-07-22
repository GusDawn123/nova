import { ragConfig, type RagConfig } from "./config.js";
import type { TranscriptTurn } from "./ports.js";
import type { RagService } from "./service.js";

/**
 * Auto-index sweeper (Phase 4) — the marker-and-sweep half of the freshness loop
 * (adr-0005 §7). The live session stamps `meetings.ended_at` on call completion;
 * this sweeper periodically picks finished-but-unindexed meetings, loads their
 * final transcript, ingests them through {@link RagService}, then stamps
 * `meetings.indexed_at`. The gap between the two timestamps is the freshness
 * contract (queryable < 60s after call end); a ~20s interval meets it with 3x
 * headroom, no queue infra (adr §7).
 *
 * Crash-safe ONLY on the sweep half: an already-ENDED but unindexed meeting
 * (`ended_at` set, `indexed_at` null) survives a restart — it is found on the next
 * sweep, and idempotent re-ingest makes double-processing harmless; every failure
 * leaves `indexed_at` null so the next sweep retries. The MARKER half is NOT
 * crash-safe: `ended_at` is stamped only by the live session's disposal, so a crash
 * mid-call (before disposal runs) leaves `ended_at` null forever and that call is
 * never swept — orphaned from memory until a stale-call reaper exists. That reaper
 * is a Phase 5 opener: sweep-side, treat a meeting whose `started_at` is old AND
 * `ended_at` is still null as ended (stamp it) so the normal sweep then picks it up.
 *
 * SINGLE-INSTANCE ASSUMPTION (adr §7): meetings are claimed by an UNGUARDED
 * `indexed_at is null` scan, so two server instances running this sweeper would
 * each pick up the same backlog. That is harmless (ingest is idempotent —
 * `replaceSource` soft-deletes then re-inserts) but wasteful. Multi-instance claim
 * semantics (`SELECT ... FOR UPDATE SKIP LOCKED`) are a logged Phase 6 opener; do
 * not run more than one instance of this sweeper until they land.
 *
 * The DB seam ({@link RagIndexerDb}) is a port — the supabase adapter lives in
 * `db/rag-indexer.ts`, so no vendor SDK enters modules/rag (RULES §5). Timers are
 * plain setInterval/clearInterval with exactly-once start/stop, mirroring the STT
 * engine's timer hygiene.
 */

/** A finished-but-unindexed meeting the sweeper must process. */
export interface UnindexedMeeting {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  /** Meeting date (e.g. `2026-07-21`) for the chunk header; omitted if unknown. */
  readonly date?: string;
}

/**
 * What the sweeper needs from the database. Implemented by the supabase adapter in
 * `db/rag-indexer.ts`. Every method is user-scoped and throws on a DB error (the
 * sweeper catches per-meeting so one failure never stalls the batch).
 */
export interface RagIndexerDb {
  /**
   * Finished, live, not-yet-indexed meetings (the Task 1 partial index:
   * `ended_at is not null and indexed_at is null and deleted_at is null`), oldest
   * completion first, capped at `limit`.
   */
  fetchUnindexed(limit: number): Promise<UnindexedMeeting[]>;
  /** This meeting's FINAL transcript turns, ordered by `ts_ms` (fallback `created_at`). */
  fetchTranscript(meetingId: string, userId: string): Promise<TranscriptTurn[]>;
  /** Stamp `indexed_at = now()` (idempotent: only where currently null). */
  markIndexed(meetingId: string, userId: string): Promise<void>;
}

/** Structured log sink (Fastify `app.log` shape). Only counts/ids cross it — never content. */
export interface IndexerLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/** The sweeper handle: background lifecycle + a directly-drivable single tick (tests). */
export interface RagIndexer {
  /** Begin the periodic sweep. Exactly-once — a second call is a no-op. */
  start(): void;
  /** Stop the periodic sweep and clear its timer. Exactly-once. */
  stop(): void;
  /** Run one sweep synchronously to completion; returns how many meetings were indexed. */
  sweepOnce(): Promise<number>;
}

/** Construction dependencies. `config` defaults to the process-wide {@link ragConfig}. */
export interface RagIndexerDeps {
  readonly ragService: RagService;
  readonly db: RagIndexerDb;
  readonly logger: IndexerLogger;
  readonly config?: Pick<RagConfig, "sweepIntervalMs" | "sweepBatchSize">;
}

/** Build the {@link RagIndexer} over explicit deps (pure of env — app.ts wires production). */
export function createRagIndexer(deps: RagIndexerDeps): RagIndexer {
  const { ragService, db, logger } = deps;
  const config = deps.config ?? ragConfig;

  let started = false;
  /** Overlapping-tick guard: true while a sweep is in flight (a slow embed/ingest). */
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function sweepOnce(): Promise<number> {
    const meetings = await db.fetchUnindexed(config.sweepBatchSize);
    let indexed = 0;
    for (const meeting of meetings) {
      try {
        const turns = await db.fetchTranscript(meeting.id, meeting.userId);
        await ragService.ingest(meeting.userId, {
          kind: "meeting",
          meetingId: meeting.id,
          title: meeting.title,
          ...(meeting.date !== undefined ? { date: meeting.date } : {}),
          turns,
        });
        // Stamp only AFTER a successful ingest. An empty transcript still stamps
        // (zero chunks) so it is never retried forever; an ingest FAILURE leaves
        // `indexed_at` null (handled below) so the next sweep retries this meeting.
        await db.markIndexed(meeting.id, meeting.userId);
        indexed += 1;
        logger.info(
          {
            user_id: meeting.userId,
            meeting_id: meeting.id,
            turns: turns.length,
          },
          "rag.index.meeting",
        );
      } catch (err) {
        // One bad meeting must not stall the batch: log (ids/counts only) and
        // continue; `indexed_at` stays null so the next sweep retries it.
        logger.error(
          { user_id: meeting.userId, meeting_id: meeting.id, err },
          "rag.index.failed",
        );
      }
    }
    return indexed;
  }

  function tick(): void {
    // Overlapping-sweep guard: if the previous tick is still running, skip this
    // one rather than piling concurrent sweeps onto the same backlog.
    if (running) return;
    running = true;
    void sweepOnce()
      .catch((err: unknown) => {
        logger.error({ err }, "rag.index.sweep_failed");
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
          sweep_interval_ms: config.sweepIntervalMs,
          batch: config.sweepBatchSize,
        },
        "rag.indexer.started",
      );
      const id = setInterval(tick, config.sweepIntervalMs);
      // Don't let the sweeper keep the process alive during shutdown; the server's
      // listen socket holds the loop open in normal operation.
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

    sweepOnce,
  };
}
