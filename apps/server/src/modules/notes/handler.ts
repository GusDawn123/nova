import type { ClaimedJob, JobUsage } from "../../db/jobs.js";
import { AllProvidersFailedError, LlmError } from "../llm/index.js";

import type {
  NotesJobHandler,
  NotesLogger,
  NotesMeetingMeta,
  NotesPipeline,
  NotesSource,
  NotesWriter,
} from "./ports.js";

/**
 * The REAL notes job handler (Task 4) the worker delegates each claimed job to. It
 * closes the loop the store leaves open (adr-0006 §2 — `complete()` never flips
 * `notes_status`): load → generate → persist notes + flip 'completed' → report
 * `completed` with usage.
 *
 *   claim (worker)
 *     → load meeting meta + final transcript turns (NotesSource, deleted_at-aware)
 *     → pipeline.generate (single-pass | map-reduce; ends in a fallback, never
 *        throws for content — only transport/all-providers failures throw)
 *     → NotesWriter.writeNotes (UPSERT notes + notes_status='completed' + ts)
 *     → { outcome: 'completed', usage }
 *
 * Error mapping (adr §3):
 *   - meeting row MISSING → `failed` (terminal; a job for a nonexistent meeting can
 *     never succeed). The pipeline's `rawText` seam threads a fallback's raw model
 *     text here for a terminal path, but the only terminal-fail is missing-meeting,
 *     which has no raw output — so `rawOutput` stays unset this phase (the worker
 *     still wires `fail(..., rawOutput)` for when a content-terminal path lands).
 *   - meeting SOFT-DELETED → `completed` no-op (REST 404s a deleted meeting; writing
 *     notes to it is pointless, and it must not retry forever).
 *   - EMPTY transcript → the pipeline yields fallback notes → `completed` (empty is
 *     NOT an error per design).
 *   - LlmError / AllProvidersFailedError → `retry` (transient).
 *   - any OTHER thrown error (a DB blip, an unexpected shape) → `retry` (conservative;
 *     the worker dead-letters at the attempt cap).
 */

export interface NotesJobHandlerDeps {
  readonly pipeline: NotesPipeline;
  readonly source: NotesSource;
  readonly writer: NotesWriter;
  readonly logger: NotesLogger;
  /** Injected clock for `notes_generated_at` (deterministic in tests). */
  readonly now?: () => Date;
  /**
   * Claim-time llm-token quota gate (Phase 6, adr-0007 §4). Over → the job is
   * REFUSED as `failed` with 'quota_exceeded' (dead-letter + notes_status
   * 'failed' — the paywall stays visible; silently producing fallback notes
   * would hide it; regenerate after upgrade re-enqueues). Optional (keyless
   * posture) and fail-open on an internal failure.
   */
  readonly isOverLlmQuota?: (userId: string) => Promise<boolean>;
}

/** Best-effort message from an unknown thrown value (never leaks a stack to logs). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sum one token field across the per-call usage entries (undefined → 0). */
function sumTokens(
  usage: readonly JobUsage[],
  field: "inputTokens" | "outputTokens",
): number {
  return usage.reduce((total, entry) => total + (entry[field] ?? 0), 0);
}

/** Build the real pipeline-backed {@link NotesJobHandler} over explicit deps. */
export function createNotesJobHandler(
  deps: NotesJobHandlerDeps,
): NotesJobHandler {
  const { pipeline, source, writer, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());

  async function handle(
    job: ClaimedJob,
  ): Promise<
    | { outcome: "completed"; usage: JobUsage[] }
    | { outcome: "retry"; error: string }
    | { outcome: "failed"; error: string; rawOutput?: string }
  > {
    const base = { job_id: job.id, meeting_id: job.meetingId };

    // Claim-time quota gate (adr-0007 §4) — BEFORE any load or paid work. A
    // check failure FAILS OPEN (logged): quota protects spend, and the metering
    // DB being down must not dead-letter every job on the platform.
    if (deps.isOverLlmQuota) {
      let overQuota = false;
      try {
        overQuota = await deps.isOverLlmQuota(job.userId);
      } catch (err) {
        logger.error(
          { ...base, user_id: job.userId, error: errorMessage(err) },
          "notes.handler.quota_check_failed",
        );
      }
      if (overQuota) {
        logger.info(
          { ...base, user_id: job.userId },
          "notes.handler.quota_exceeded",
        );
        return { outcome: "failed", error: "quota_exceeded" };
      }
    }

    try {
      const meeting = await source.loadMeeting(job.meetingId, job.userId);
      if (meeting === null) {
        // No such meeting — terminal. A job for a nonexistent meeting never succeeds.
        logger.info(base, "notes.handler.meeting_missing");
        return { outcome: "failed", error: "meeting not found" };
      }
      if (meeting.deletedAt !== null) {
        // Soft-deleted mid-flight: complete as a no-op (do not resurrect its notes,
        // do not retry forever).
        logger.info(base, "notes.handler.meeting_deleted");
        return { outcome: "completed", usage: [] };
      }

      const turns = await source.loadTranscript(job.meetingId, job.userId);
      const meta: NotesMeetingMeta = {
        id: meeting.id,
        userId: meeting.userId,
        title: meeting.title,
        startedAt: meeting.startedAt,
      };

      const { notes, usage } = await pipeline.generate(meta, turns);
      await writer.writeNotes(job.meetingId, job.userId, notes, now());

      // The per-user cost line (playbook "token usage per summary logged per user";
      // the Phase 6 metering seam). Ids + counts ONLY — never transcript content
      // (RULES §6). The per-call breakdown persists on `jobs.usage` (jsonb) via the
      // store's `complete()`; this log is its observable summary.
      logger.info(
        {
          ...base,
          user_id: job.userId,
          input_tokens: sumTokens(usage, "inputTokens"),
          output_tokens: sumTokens(usage, "outputTokens"),
          calls: usage.length,
          notes_source: notes.source,
        },
        "notes.handler.completed",
      );
      return { outcome: "completed", usage };
    } catch (err) {
      // Transport/all-providers failures are transient; everything else is treated
      // conservatively as transient too (retry; the worker dead-letters at the cap).
      // Content failures never reach here — the ladder ends in a fallback that
      // completes.
      const transient =
        err instanceof LlmError || err instanceof AllProvidersFailedError;
      logger.error({ ...base, transient }, "notes.handler.retry");
      return { outcome: "retry", error: errorMessage(err) };
    }
  }

  return { handle };
}
