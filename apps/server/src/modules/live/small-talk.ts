/**
 * Small-talk detection for the live trigger gate. `trigger.ts` uses it to decide
 * whether an utterance is worth a SUGGESTION. (It was extracted to its own module
 * when the live-notes fold shared it; the fold is gone — 2026-08-04 — and the
 * extraction is harmless, so it stays.)
 *
 * Extracted verbatim from `trigger.ts` (Phase 7) — no pattern changed, so the 11/11
 * quiet fixtures and the 3 filler-prefix fixtures still describe the same behavior.
 */

/**
 * Small-talk phrases/backchannels. A whole utterance dominated by these is a
 * no-op window. Deliberately matched on a NORMALIZED (lowercased, de-punctuated)
 * form so "How are you?" and "how are you" collapse together.
 */
export const SMALL_TALK_PATTERNS: readonly RegExp[] = [
  /^(hi|hey|hello|yo|hiya)\b/,
  /^good (morning|afternoon|evening)\b/,
  /how are you\b/,
  /how'?s it going\b/,
  /how have you been\b/,
  /how was your (weekend|day|week)\b/,
  /what'?s up\b/,
  /nice to (meet|see) you\b/,
  /good to (see|meet) you\b/,
  /long time no see\b/,
  /(take care|talk (to you )?later|catch you later|have a (good|great) (one|day))\b/,
  /^(bye|goodbye|see ya|see you)\b/,
  /^(thanks|thank you|thx|cheers)\b/,
  /^(ok|okay|cool|nice|great|awesome|sweet|gotcha|got it|right|sure|yeah|yep|yup|yes|no|nope|totally|for sure|sounds good|makes sense|mhm|uh huh|haha|lol)\b/,
  /nice weather\b/,
  /how about (you|yourself)\b/,
];

/**
 * Leading backchannel/filler tokens that can precede a real question ("okay, so
 * how would you…"). Stripped so the small-talk veto re-tests the substance
 * behind them (the 2026-07-23 filler-prefix fix).
 */
const FILLER_PREFIX =
  /^(?:(?:ok|okay|cool|nice|great|awesome|right|sure|yeah|yep|yup|yes|no|nope|well|alright|so|um|uh|hey|hi|hello|but|and|anyway|honestly|actually)[,.!\s]+)+/;

/** Normalize for pattern matching: lowercase, collapse whitespace, trim. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Is the utterance dominated by pleasantries/backchannels? */
export function isSmallTalk(normalized: string): boolean {
  return SMALL_TALK_PATTERNS.some((re) => re.test(normalized));
}

/** Drop leading filler/backchannel tokens from a normalized utterance. */
export function stripFillerPrefix(normalized: string): string {
  return normalized.replace(FILLER_PREFIX, "");
}
