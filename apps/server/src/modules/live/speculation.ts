/**
 * Speculation reconcile (Phase 7, design: live-pipeline.md §modules/live). Sub-
 * second feel comes from firing a suggestion on a CONFIDENT partial — before the
 * utterance even ends — then reconciling against the final. This module is the
 * PURE decision math; the conductor owns the streams and the wire events.
 *
 * On the final utterance we compare it to the partial we speculated on:
 *   - similar enough (Jaccard ≥ threshold) → ADOPT the in-flight/finished answer
 *     (the speculation paid off — no discard, no refire)
 *   - diverged → the partial was wrong; the conductor emits `suggestion.discard`
 *     for the speculative one and fires fresh on the final (never a zombie card)
 */

/** Tokenize to a lowercased word set for a set-similarity comparison. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

/** Jaccard similarity of two texts' word sets (1 = identical sets, 0 = disjoint). */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const w of sa) {
    if (sb.has(w)) intersection += 1;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * A partial is "confident enough" to speculate on when it already reads like a
 * complete thought: long enough AND either ends with a question mark or has a
 * clause-worth of words. Kept conservative — a bad speculation costs a discard
 * (visible flicker), so we only fire when the partial is likely near-final.
 */
export function isConfidentPartial(text: string, minWords: number): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= minWords;
}

/** Reconcile decision: keep the speculative suggestion, or discard + refire. */
export type ReconcileDecision = "adopt" | "discard";

/** Decide adopt-vs-discard for a speculation against its final utterance. */
export function reconcile(
  speculativeTrigger: string,
  finalText: string,
  threshold: number,
): ReconcileDecision {
  return jaccardSimilarity(speculativeTrigger, finalText) >= threshold
    ? "adopt"
    : "discard";
}
