/**
 * The one documented token estimator for modules/notes. There is no tokenizer
 * dependency in this module (adr-0006 §5): a call's size is estimated with the
 * chars/token heuristic the whole pipeline shares — the SAME estimator Task 3's
 * classify head-truncation uses (`classifyHeadTokens × CHARS_PER_TOKEN`) and Task
 * 4's single-pass gate + map chunking use. Kept in one place so the two never drift.
 *
 * ~4 chars/token is the conventional English-text approximation; it is deliberately
 * conservative for gating (over- rather than under-estimating a transcript's size
 * pushes borderline calls onto the safer map-reduce path).
 */

/** Characters per token in the shared heuristic (no tokenizer; adr-0006 §5). */
export const CHARS_PER_TOKEN = 4;

/** Estimate the token count of a string via the chars/token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
