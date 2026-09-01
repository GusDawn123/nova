import { z } from "zod";

/**
 * Conductor tunables (Phase 7). The deadline ladder and context budgets live
 * here so a test can drive them with tiny values under fake timers and the
 * latency benchmark can assert against the real defaults. Budgets SHRINK what is
 * gathered; they never delay the first token (design: live-pipeline.md).
 */
export const conductorConfigSchema = z.object({
  /**
   * Hard deadline from generation start to the FIRST suggestion token. If the
   * router yields nothing by here, the attempt is actively aborted (the deadline
   * ladder). Re-sized 2026-08-17 after the old 4s gate aborted BOTH cascade
   * rungs on the then-current thinking models (killing the whole answer). The
   * 2026-08-19 model revert put non-thinking models back, but the generous
   * window is KEPT DELIBERATELY — it only slows the failure path, never a
   * healthy answer. Sized to cover the router's per-provider TTFT window twice
   * (primary + one failover) plus slack.
   */
  firstTokenDeadlineMs: z.number().int().positive().default(12000),
  /**
   * How long RAG grounding may take before the conductor proceeds WITHOUT
   * snippets. Retrieval shrinks the prompt; it must never delay first token
   * (adr-0005 §8), so a slow query is raced against this and dropped.
   */
  ragDeadlineMs: z.number().int().positive().default(400),
  /** Server-side token coalescing window — one wire delta per ~batch (design). */
  coalesceMs: z.number().int().positive().default(50),
  /** RAG snippet token budget handed to the assembler for grounding. */
  ragTokenBudget: z.number().int().positive().default(600),
  /** Number of RAG snippets requested per trigger (live tier, no rerank). */
  ragK: z.number().int().positive().default(3),
  /** Rolling transcript turns retained for context (the assembler re-windows). */
  transcriptWindowTurns: z.number().int().positive().default(40),
  /** Min words in a partial before it is "confident" enough to speculate on. */
  speculationMinWords: z.number().int().positive().default(6),
  /** Jaccard similarity at/above which a speculation is adopted vs discarded. */
  speculationThreshold: z.number().min(0).max(1).default(0.6),
  /**
   * Whether to speculate on confident partials at all. On by default (it is the
   * sub-second-feel lever); tests toggle it to isolate the non-speculative path.
   */
  speculationEnabled: z.boolean().default(true),
});

export type ConductorConfig = z.infer<typeof conductorConfigSchema>;

/** Process-wide default conductor config. */
export const conductorConfig: ConductorConfig = conductorConfigSchema.parse({});
