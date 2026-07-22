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
