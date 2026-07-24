import { z } from "zod";

/**
 * Hard token budgets for the dynamic suffix (design: live-pipeline.md — "RAG
 * snippets under a hard token budget", "keeping the dynamic suffix small" is the
 * real prompt-side latency lever, adr-0004 §6). Budgets SHRINK the suffix, they
 * never delay the first token: the conductor already caps how much it gathers,
 * and the assembler trims defensively on top. All char/token math is the repo's
 * ~4-chars/token heuristic — no tokenizer dependency on the hot path.
 */
export const promptConfigSchema = z.object({
  /** Max tokens of windowed transcript kept (most-recent turns win). */
  transcriptBudgetTokens: z.number().int().positive().default(1200),
  /** Hard cap on Σ RAG-snippet tokens injected for grounding. */
  ragBudgetTokens: z.number().int().positive().default(600),
  /** Hard cap on user-provided context tokens (truncated, never dropped whole). */
  userContextBudgetTokens: z.number().int().positive().default(800),
});

export type PromptConfig = z.infer<typeof promptConfigSchema>;

/** The process-wide default budgets. */
export const promptConfig: PromptConfig = promptConfigSchema.parse({});

/** The repo-wide ~4-chars/token heuristic (matches chunker/notes estimators). */
const CHARS_PER_TOKEN = 4;

/** Approximate token count of a string (chars/4, floored). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
