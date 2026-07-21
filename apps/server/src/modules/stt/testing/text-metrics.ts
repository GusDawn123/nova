/**
 * Word-overlap metric for the key-gated STT accuracy tests (Phase 3.5). Kept in
 * `testing/` (never imported by production) and unit-tested directly, so the
 * accuracy bars (≥80% clean / ≥70% noisy) rest on a metric with known behavior
 * rather than an ad-hoc inline comparison.
 *
 * The metric is recall of the KNOWN reference tokens in the vendor hypothesis:
 * `(reference tokens found in hypothesis) / (reference tokens)`, multiset-aware
 * so a word required twice must appear twice. Recall (not F1) is the right lens
 * here — we ask "how much of what was actually said did the vendor capture?",
 * and a vendor is not penalized for extra filler tokens synthetic TTS can induce.
 */

/**
 * Lowercase, strip punctuation to spaces (Unicode-aware), split on whitespace.
 * Contractions collapse (e.g. "don't" → "don" "t"); applied identically to both
 * sides, so it never biases the overlap.
 */
export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Build a token → count multiset. */
function multiset(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fraction of `reference` tokens present in `hypothesis` (0..1), multiset-aware.
 * An empty reference scores 1 against an empty hypothesis, else 0.
 */
export function normalizedTokenOverlap(
  reference: string,
  hypothesis: string,
): number {
  const referenceTokens = normalizeTokens(reference);
  if (referenceTokens.length === 0) {
    return normalizeTokens(hypothesis).length === 0 ? 1 : 0;
  }

  const available = multiset(normalizeTokens(hypothesis));
  let matched = 0;
  for (const token of referenceTokens) {
    const remaining = available.get(token) ?? 0;
    if (remaining > 0) {
      matched += 1;
      available.set(token, remaining - 1);
    }
  }
  return matched / referenceTokens.length;
}
