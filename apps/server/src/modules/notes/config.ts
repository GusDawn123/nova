import { z } from "zod";

/**
 * modules/notes tunables — one zod schema, every knob `.default()`ed and injectable
 * (adr-0006 §3: all lease/backoff/interval numbers are config so the recovery test
 * runs in seconds). No `process.env` reads live in this module; env wiring stays in
 * app.ts/env.ts (the RAG gating precedent). Later tasks (3/4) add generation knobs
 * to this same schema.
 *
 * Design sources: `docs/DESIGN/notes-pipeline.md`, `docs/DECISIONS/adr-0006-notes-pipeline.md`.
 */
export const notesConfigSchema = z
  .object({
    /** Worker poll cadence — one claim attempt per tick (adr §3). */
    pollIntervalMs: z.number().int().positive().default(5_000),
    /** Lease length: ≥2–3× the worst job so a healthy job never gets reaped. */
    leaseMs: z.number().int().positive().default(600_000),
    /** Lease-reaper cadence: requeue|dead-letter expired processing rows. */
    reaperIntervalMs: z.number().int().positive().default(30_000),
    /** Attempts before a job is dead-lettered. */
    maxAttempts: z.number().int().positive().default(5),
    /** Backoff base: first retry lands ~60s out. */
    backoffBaseMs: z.number().int().positive().default(60_000),
    /** Backoff growth factor per attempt (60s · 3^(n−1)). */
    backoffFactor: z.number().positive().default(3),
    /** Backoff ceiling (15 min) — a stuck vendor never pushes retries hours out. */
    backoffCapMs: z.number().int().positive().default(900_000),
    /** Sweep-backstop batch cap — bounds burst enqueue from many ended calls. */
    sweepBatchSize: z.number().int().positive().default(10),
    /** A call with no `ended_at` older than this is treated as crashed (6h). */
    staleCallMaxAgeMs: z.number().int().positive().default(21_600_000),
    /** Stale-call reaper cadence. */
    staleReaperIntervalMs: z.number().int().positive().default(60_000),
    /** Single-pass token gate; above it the pipeline maps-reduces (Task 3/4). */
    maxSinglePassTokens: z.number().int().positive().default(32_000),
    /** Map-step chunk size at turn boundaries (Task 4). */
    mapChunkTokens: z.number().int().positive().default(6_000),
    /** Map-step overlap ratio (~15%, Task 4). */
    mapOverlapRatio: z.number().min(0).max(1).default(0.15),
    /** Classification reads the transcript head (~2k tokens, Task 3). */
    classifyHeadTokens: z.number().int().positive().default(2_000),
  })
  .strict();

export type NotesConfig = z.infer<typeof notesConfigSchema>;

/** The process-wide defaults (parse of an empty object — every field is defaulted). */
export const notesConfig: NotesConfig = notesConfigSchema.parse({});

/** Jitter spread applied to every backoff delay (±10%, adr §3). */
const JITTER_RATIO = 0.1;

/**
 * Jittered exponential backoff delay in ms: `base · factor^(attempts−1)`, capped,
 * then spread ±10% via the injected `rand` (a pure `() => number` in `[0, 1)` — so
 * unit tests are deterministic). Pure function; the worker owns turning the delay
 * into a `run_at` timestamp.
 */
export function computeBackoff(
  attempts: number,
  cfg: Pick<NotesConfig, "backoffBaseMs" | "backoffFactor" | "backoffCapMs">,
  rand: () => number = Math.random,
): number {
  const step = Math.max(0, attempts - 1);
  const raw = cfg.backoffBaseMs * Math.pow(cfg.backoffFactor, step);
  const capped = Math.min(raw, cfg.backoffCapMs);
  const jitter = 1 + (rand() * 2 - 1) * JITTER_RATIO;
  return Math.round(capped * jitter);
}
