import type { ClaimedJob, JobUsage } from "../../db/jobs.js";

/**
 * modules/notes seams (Task 2 skeleton; Task 3 extends). This file defines the
 * module-local contracts the worker is generic over — no vendor SDK, no DB, no
 * network. The durable-queue seam is the EXISTING {@link NotesJobStore} in
 * `db/jobs.ts`; the generation seam is {@link NotesJobHandler}, which Task 4 plugs
 * the real pipeline into.
 *
 * Design sources: `docs/DESIGN/notes-pipeline.md`, `docs/DECISIONS/adr-0006-notes-pipeline.md`.
 */

/** Re-export the store's boundary types so consumers import notes contracts in one place. */
export type { ClaimedJob, JobUsage } from "../../db/jobs.js";

/**
 * The generation step the worker delegates each claimed job to. A discriminated
 * `outcome` (RULES §10) the worker maps to a store transition:
 * - `completed` → `store.complete` (usage recorded; notes write happens inside the
 *   handler in Task 4, which also flips `notes_status` to 'completed').
 * - `retry` → jittered backoff → `store.retry` (transient: 429/5xx/timeout/all
 *   providers down). At the attempt cap the worker dead-letters instead.
 * - `failed` → `store.fail` (terminal; `rawOutput` keeps the raw model text off the
 *   typed notes column).
 *
 * The handler NEVER throws for content reasons (the pipeline's ladder ends in a
 * fallback that still `completed`s); a thrown error is treated by the worker as a
 * transient retry (at-least-once, adr §3).
 */
export interface NotesJobHandler {
  handle(
    job: ClaimedJob,
  ): Promise<
    | { outcome: "completed"; usage: JobUsage[] }
    | { outcome: "retry"; error: string }
    | { outcome: "failed"; error: string; rawOutput?: string }
  >;
}

/**
 * Structured log sink (Fastify `app.log` shape) — only ids/counts ever cross it,
 * never transcript content (RULES §6). Mirrors the RAG indexer's `IndexerLogger`.
 */
export interface NotesLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/** The worker handle: background lifecycle + a directly-drivable single poll tick. */
export interface NotesWorker {
  /** Begin the poll + reaper loops. Exactly-once — a second call is a no-op. */
  start(): void;
  /** Stop both loops and clear their timers. Exactly-once. */
  stop(): void;
  /** Run one poll tick to completion; returns how many jobs were processed (0 or 1). */
  tickOnce(): Promise<number>;
}
