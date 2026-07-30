import { isSmallTalk, normalize } from "./small-talk.js";

/**
 * The notes-fold gate (Phase 8, docs/DESIGN/live-notes.md §5). Pure, synchronous,
 * off the LLM hot path: given the transcript delta accrued since the last fold,
 * decide whether it is worth spending a fold on.
 *
 * IT MIRRORS `trigger.ts` IN SHAPE BUT NOT IN ECONOMICS, and the difference is the
 * whole design:
 *
 *   - `trigger.ts` gates a PER-UTTERANCE call, so a false fire is expensive and a
 *     false quiet is nearly free. It is tuned to stay quiet.
 *   - This gate sits BEHIND a ~25s debounce, so the debounce is the real rate
 *     limiter. On a live sales call, numbers/dates/named entities fire on nearly
 *     every turn — this is a SMALL-TALK SUPPRESSOR, not the cost control. Expect it
 *     to fire often; that is correct, not a bug.
 *   - Its false-QUIET mode is genuinely dangerous in a way `trigger.ts`'s is not: a
 *     decision with no lexical cue ("yeah, let's do that") is invisible to a lexical
 *     heuristic, and a missed fold loses that content until the post-call pass.
 *     That risk is mitigated by the conductor's token FORCE-FIRE (§4 step 4), not
 *     by this gate — do not try to fix it by loosening the patterns here.
 *
 * Reasons are cue NAMES only, never matched text: the delta is transcript content
 * and these decisions are logged (RULES §6).
 */

/** What the gate decides for one delta. `reason` names the cue, never quotes it. */
export interface NotesTriggerDecision {
  readonly fire: boolean;
  readonly reason: string;
}

/** The gate only needs the words; the conductor owns speakers and timestamps. */
export interface NotesDeltaTurn {
  readonly text: string;
}

/** A delta with less substance than this (non-space chars) is never worth a fold. */
const MIN_DELTA_CHARS = 24;

/**
 * An explicit decision was reached. Highest-signal cue there is — this is the
 * content the notes exist to capture, so it is tested first.
 */
const DECISION_MARKERS =
  /\b(decided|decision|we'?re going with|let'?s go with|going with|agreed on|the plan is|next steps?|settled on|sign(ed)? off|final(is|iz)ed)\b/;

/** Somebody committed to doing something — the action-item signal. */
const COMMITMENT_VERBS =
  /\b(i'?ll|we'?ll|i will|we will|going to|gonna|let'?s|we should|we need to|i can|we can|agreed|promise|commit(ted)?|send (you|over|the)|ship|deliver|follow up|circle back|schedule|book|set up|confirm|sign)\b/;

/** Dates and relative-time phrases — the deadline signal. */
const DATE_PHRASES =
  /\b(today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|next (week|month|quarter|year|monday|tuesday|wednesday|thursday|friday)|this (week|month|quarter|afternoon|morning|evening)|last (week|month|quarter)|end of (the )?(day|week|month|quarter|year)|eod|eow|q[1-4]|by (then|the)|deadline|due)\b/;

/** Numerals, currency, percentages — pricing, headcount, targets. */
const NUMERIC = /(\d|[$£€]|\b(percent|thousand|million|billion|dozen|half)\b)/;

/** Disagreement / pushback — the objection and risk signal. */
const NEGATION_OF_AGREEMENT =
  /\b(don'?t think|not sure|i disagree|disagree|won'?t work|doesn'?t work|can'?t do|cannot do|not going to work|concern(ed|s)?|worried|risk(y|s)?|blocker|problem with|pushback|too expensive|out of budget|hesitant)\b/;

/**
 * A proper noun / technical term: a capitalized token that is not the first word
 * of a sentence, or an internally-capitalized product name (CamelCase). Same
 * heuristic family as `trigger.ts`'s end-term scan, applied across the whole delta.
 */
const COMMON_CAPS = new Set([
  "I",
  "I'm",
  "I've",
  "I'll",
  "I'd",
  "The",
  "This",
  "That",
  "These",
  "Those",
  "There",
  "So",
  "And",
  "But",
  "Or",
  "Well",
  "Yeah",
  "Yes",
  "No",
  "Okay",
  "Ok",
  "Nice",
  "Good",
  "Great",
  "Cool",
  "Sure",
  "Right",
  "Last",
  "Next",
  "First",
  "Hey",
  "Hi",
  "Hello",
  "Thanks",
  "Maybe",
  "Actually",
  "Honestly",
  "We",
  "You",
  "They",
  "He",
  "She",
  "It",
  "If",
  "When",
  "What",
  "How",
  "Why",
  "Let",
  "Just",
]);

function hasProperNoun(raw: string): boolean {
  const words = raw.trim().split(/\s+/);
  return words.some((word, i) => {
    const clean = word.replace(/[^A-Za-z0-9'.-]/g, "");
    if (clean.length < 2) return false;
    if (i === 0) return false; // never the delta's first word
    const prev = words[i - 1] ?? "";
    if (/[.!?]$/.test(prev)) return false; // a new sentence's first word
    if (COMMON_CAPS.has(clean)) return false;
    const first = clean[0] ?? "";
    const isCapitalized = first >= "A" && first <= "Z";
    const hasInternalCaps = /[a-z][A-Z]/.test(clean);
    return isCapitalized || hasInternalCaps;
  });
}

/** Does any turn in the delta read as a question? */
function hasQuestion(turns: readonly NotesDeltaTurn[]): boolean {
  return turns.some((turn) => turn.text.trimEnd().endsWith("?"));
}

/**
 * The strong lexical cues, cheapest and highest-signal first. Returns the cue's
 * name, or null when the text carries none. Questions and proper nouns are
 * deliberately NOT here: they are weak cues, and treating them as strong would
 * exempt every "how are you?" from the small-talk veto.
 */
function lexicalCue(normalized: string): string | null {
  const strong = strongCue(normalized);
  if (strong !== null) return strong;
  if (DATE_PHRASES.test(normalized)) return "date_phrase";
  return null;
}

/**
 * The cues strong enough to overrule the small-talk veto. Dates are deliberately
 * NOT among them: "how are you doing today?" carries a date word and no substance
 * whatsoever, so honouring it here would break the veto on the most common
 * pleasantry there is. A date still fires on its own for a delta that is not pure
 * pleasantry — it is a fine reason to fold, just not evidence of substance.
 */
function strongCue(normalized: string): string | null {
  if (DECISION_MARKERS.test(normalized)) return "decision_marker";
  if (COMMITMENT_VERBS.test(normalized)) return "commitment";
  if (NUMERIC.test(normalized)) return "numeric";
  if (NEGATION_OF_AGREEMENT.test(normalized)) return "negation";
  return null;
}

/**
 * Is this turn PURE pleasantry — small talk with nothing of substance behind it?
 *
 * The second half of that question is load-bearing. The small-talk patterns are
 * anchored to utterance openings, so "Okay, we're going with the annual plan" and
 * "Yeah, so we decided to move the launch" both match on their backchannel opener
 * alone. Vetoing those would drop a decision on the floor — the exact false-quiet
 * failure mode §5 calls the dangerous one. A turn carrying a strong cue is never
 * counted toward the veto, whatever it opens with.
 */
function isPureSmallTalk(text: string): boolean {
  const normalized = normalize(text);
  return isSmallTalk(normalized) && strongCue(normalized) === null;
}

/**
 * Evaluate the gate over the delta accrued since the last fold.
 *
 * A delta of PURE pleasantries is the one thing that reliably deserves a skip:
 * every turn must be small talk for the veto to apply, because one substantive
 * turn buried in chit-chat is exactly the content a fold must not miss.
 */
export function evaluateNotesTrigger(
  turns: readonly NotesDeltaTurn[],
): NotesTriggerDecision {
  const raw = turns
    .map((turn) => turn.text.trim())
    .filter((text) => text !== "")
    .join(" ")
    .trim();

  if (raw.replace(/\s/g, "").length < MIN_DELTA_CHARS) {
    return { fire: false, reason: "too_short" };
  }

  const normalized = normalize(raw);

  // EVERY turn pure pleasantry → a no-op window. Checked per TURN, not over the
  // joined text: the patterns are anchored to utterance starts, so joining first
  // would let one leading "hey" veto a whole substantive delta.
  const spoken = turns.filter((turn) => turn.text.trim() !== "");
  if (spoken.length > 0 && spoken.every((turn) => isPureSmallTalk(turn.text))) {
    return { fire: false, reason: "small_talk" };
  }

  const cue = lexicalCue(normalized);
  if (cue !== null) {
    return { fire: true, reason: cue };
  }
  if (hasQuestion(turns)) {
    return { fire: true, reason: "question" };
  }
  if (hasProperNoun(raw)) {
    return { fire: true, reason: "proper_noun" };
  }

  return { fire: false, reason: "no_cue" };
}
