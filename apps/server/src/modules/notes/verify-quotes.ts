import type { MeetingNotes } from "@nova/shared";

/**
 * Post-generation evidence guards (adr-0006 §6). LLM output is hostile input, so
 * after the ladder produces a schema-valid notes object we cheaply ground it
 * against the transcript BEFORE it is stored:
 *
 *   - Quote verification — every decision/action-item `quote` is substring-checked
 *     (whitespace-normalized) against the joined transcript. A miss FLAGS the item
 *     `unverified:true` (kept for recall — the fixture-facts bar — never dropped).
 *     A `null` quote is allowed and never flagged (the model found no evidence).
 *   - Invented-date guard — an action item with a non-null ISO `deadline` but a
 *     `null` `deadlineRaw` has no verbatim source phrase behind the date, so BOTH
 *     are nulled (the model resolved a date it never actually heard).
 *
 * ## Normalization choices (documented per the brief)
 *
 * Both the transcript and each quote are normalized the SAME way before the
 * substring test, tolerating the differences an ASR/LLM round-trip introduces
 * without opening the check up to false positives:
 *   1. Curly quotes/apostrophes (` ` `“” `’`) → straight (`'` / `"`), and common
 *      unicode dashes/ellipsis → ASCII — the model routinely "tidies" punctuation.
 *   2. All whitespace runs (newlines/tabs/multiple spaces) → a single space, trimmed
 *      — diarized turns are re-joined, so inter-line spacing must not matter.
 *   3. Lowercased — casing is not evidence (the ASR and the model disagree on it
 *      constantly); a case-only difference must NOT flag a real quote unverified.
 *
 * Pure function; returns a NEW notes object (never mutates its input).
 */

/** Join the spoken text of every turn into one verification corpus. */
export function joinTranscriptText(turns: { text: string }[]): string {
  return turns.map((turn) => turn.text).join(" ");
}

/** Apply the documented normalization: punctuation → ASCII, whitespace collapse, lowercase. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'") // curly/prime single quotes → '
    .replace(/[“”″]/g, '"') // curly/prime double quotes → "
    .replace(/[–—−]/g, "-") // en/em dash, minus → -
    .replace(/…/g, "...") // ellipsis → ...
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Verify quotes + apply the invented-date guard against the joined transcript.
 * Returns a new {@link MeetingNotes}; the input is untouched.
 */
export function verifyNotes(
  notes: MeetingNotes,
  transcript: string,
): MeetingNotes {
  const corpus = normalizeForMatch(transcript);
  const isGrounded = (quote: string): boolean =>
    corpus.includes(normalizeForMatch(quote));

  const decisions = notes.decisions.map((decision) => {
    if (decision.quote === null || isGrounded(decision.quote)) {
      return decision;
    }
    return { ...decision, unverified: true as const };
  });

  const actionItems = notes.actionItems.map((item) => {
    // Invented-date guard first: a resolved ISO date with no verbatim phrase behind
    // it was never actually stated — null both so it can't read as a real deadline.
    const guarded =
      item.deadline !== null && item.deadlineRaw === null
        ? { ...item, deadline: null, deadlineRaw: null }
        : item;
    if (guarded.quote === null || isGrounded(guarded.quote)) {
      return guarded;
    }
    return { ...guarded, unverified: true as const };
  });

  return { ...notes, decisions, actionItems };
}
