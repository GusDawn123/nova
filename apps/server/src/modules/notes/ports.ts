import type { MeetingNotes } from "@nova/shared";

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
 * One diarized transcript turn the pipeline reasons over (Task 3). Defined HERE,
 * not imported from `modules/rag` — modules are islands (RULES §2), so notes owns
 * its own transcript shape even though it mirrors the rag turn's fields. `speaker`
 * is the diarized label (null when the STT layer could not attribute the line);
 * `tsMs` is the turn's start offset in ms (null when unknown).
 */
export interface TranscriptTurn {
  readonly speaker: string | null;
  readonly text: string;
  readonly tsMs: number | null;
}

/**
 * The meeting metadata the pipeline needs to generate notes — a projection of the
 * meetings row (no transcript here; turns are passed separately). `startedAt` (ISO)
 * anchors relative-deadline resolution; a null falls back to the injected clock.
 */
export interface NotesMeetingMeta {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly startedAt: string | null;
}

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

/**
 * The generation core (Task 3 single-pass; Task 4 adds map-reduce). `generate`
 * NEVER throws for content reasons — the ladder ends in a deterministic fallback
 * that still yields valid notes — it throws only on transport/all-providers
 * failures (`LlmError`/`AllProvidersFailedError`), which the worker classifies as a
 * retry (adr-0006 §3). `usage` carries one {@link JobUsage} per model call
 * (classify, generate/map/reduce, and any repair round-trip). `rawText` is the
 * last raw model text, surfaced ONLY when the ladder fell back (Task 4) so a
 * terminal handler path can hand it to `jobs.raw_output` — omitted on the clean
 * path.
 */
export interface NotesPipeline {
  generate(
    meta: NotesMeetingMeta,
    turns: TranscriptTurn[],
  ): Promise<{ notes: MeetingNotes; usage: JobUsage[]; rawText?: string }>;
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
