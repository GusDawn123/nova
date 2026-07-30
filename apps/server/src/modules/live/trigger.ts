import { isSmallTalk, normalize, stripFillerPrefix } from "./small-talk.js";

/**
 * The tiered trigger gate (Phase 7, design: live-pipeline.md §modules/live). The
 * cheapest call is the one never made, so this is a PURE, synchronous heuristic
 * cascade that runs OFF the LLM hot path on every final utterance and decides
 * whether a suggestion is worth generating at all. Its prime directive is to
 * stay QUIET in small-talk windows — suggestion spam is the #1 uninstall driver.
 *
 * Tiers (cheapest first; first match wins):
 *   0. triviality — too short / empty → never fire
 *   1. small-talk veto — pleasantries/backchannels (even question-SHAPED ones
 *      like "how are you?") → never fire, UNLESS a proper-noun term rides along
 *   2. question — a real question at the end → fire "answer"
 *   3. term — a proper noun / company / technical term in the last words → "define"
 *   4. advancement — a substantial statement from the other party, no question →
 *      "advance" (follow-ups); conservative so it doesn't chatter
 *   else → no fire (passive mode)
 *
 * The kinds mirror the authored prompt's decision hierarchy (answer > define >
 * advance); the LLM still owns the actual behavior — this only gates spend.
 */

/** What the gate decides for one utterance. Discriminated on `fire`. */
export type TriggerDecision =
  | { readonly fire: false; readonly reason: string }
  | {
      readonly fire: true;
      readonly kind: "answer" | "define" | "advance";
      readonly reason: string;
    };

/** Utterances at or under this many non-space chars are never worth a call. */
const MIN_UTTERANCE_CHARS = 8;

/**
 * STRONG interrogatives — rare in declaratives, so a match in the first few
 * words signals a question ("so how did you…", "and what about…").
 */
const STRONG_OPENERS = [
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "which",
  "whose",
  "whom",
] as const;

/**
 * WEAK interrogatives — also common mid-declarative ("mostly DID Foundry work"),
 * so they only signal a question at the VERY start ("Did you…", "Can you…").
 */
const WEAK_OPENERS = [
  "can",
  "could",
  "would",
  "should",
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "will",
  "have",
  "has",
] as const;

/** Multiword request phrases that read as a question wherever they appear early. */
const QUESTION_PHRASES = [
  "tell me",
  "walk me",
  "curious about",
  "wondering",
  "what about",
  "explain",
  "describe",
] as const;

/** Does the utterance read as a question (mark OR interrogative form)? */
function looksLikeQuestion(raw: string, normalized: string): boolean {
  if (raw.trimEnd().endsWith("?")) return true;
  const words = normalized.split(" ");
  const head = words.slice(0, 3);
  // Strong interrogatives anywhere in the first three words.
  if (
    head.some((word) =>
      STRONG_OPENERS.some((opener) => word.startsWith(opener)),
    )
  ) {
    return true;
  }
  // Weak interrogatives only at the very start.
  const first = words[0] ?? "";
  if (
    WEAK_OPENERS.some((opener) => first === opener || first === `${opener}'t`)
  ) {
    return true;
  }
  // Request phrases in the leading clause.
  const lead = head.join(" ");
  return QUESTION_PHRASES.some((phrase) => lead.includes(phrase));
}

/**
 * A proper-noun / technical term in the LAST ~15 words (the prompt's
 * definition trigger window). Heuristic: a Capitalized token that is NOT the
 * first word of a sentence and not a trivially common word. Conservative — it
 * only needs to catch clear company/tool/product nouns, the LLM filters the rest.
 */
const COMMON_CAPS = new Set([
  "I",
  "I'm",
  "I've",
  "I'll",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  // Common sentence-openers / interjections that are capitalized but not terms.
  "The",
  "This",
  "That",
  "These",
  "Those",
  "So",
  "And",
  "But",
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
]);

function hasEndTerm(raw: string): boolean {
  const words = raw.trim().split(/\s+/);
  const startFrom = Math.max(0, words.length - 15);
  return words.some((word, i) => {
    if (i < startFrom) return false; // only the last ~15 words
    const clean = word.replace(/[^A-Za-z0-9'.-]/g, "");
    if (clean.length < 2) return false;
    if (i === 0) return false; // never the utterance's first word
    // Skip a new-sentence start: the previous token ended a sentence.
    const prev = words[i - 1] ?? "";
    if (/[.!?]$/.test(prev)) return false;
    if (COMMON_CAPS.has(clean)) return false;
    const first = clean[0] ?? "";
    // Capitalized (proper noun) OR internal caps (CamelCase tool names).
    const isCapitalized = first >= "A" && first <= "Z";
    const hasInternalCaps = /[a-z][A-Z]/.test(clean);
    return isCapitalized || hasInternalCaps;
  });
}

/** Enough of a statement from the other party to be worth advancing? */
function isAdvancementStatement(raw: string): boolean {
  const words = raw.trim().split(/\s+/);
  return words.length >= 12;
}

/**
 * Evaluate the trigger gate for one FINAL utterance. `speakerIsUser` marks a
 * turn the STT labeled as the user ("me") — advancement follow-ups are for the
 * OTHER party's statements, so a user turn never triggers advancement.
 */
export function evaluateTrigger(
  text: string,
  speakerIsUser: boolean,
): TriggerDecision {
  const raw = text.trim();
  const normalized = normalize(raw);
  if (raw.replace(/\s/g, "").length <= MIN_UTTERANCE_CHARS) {
    return { fire: false, reason: "too_short" };
  }

  // Small-talk veto FIRST — pleasantries/backchannels are a no-op window even
  // when question-shaped ("how are you?"). Staying quiet outranks a marginal
  // define on a stray capitalized word inside a greeting (spam is the bigger risk).
  //
  // EXCEPT (2026-07-23 fix, Gustavo-approved): a SUBSTANTIAL question must never
  // be vetoed by its filler prefix — "Okay, so how would you price this?" opens
  // with a backchannel ("okay") but IS a real question. For an utterance that
  // ends in "?" AND carries ≥6 words, the veto is re-tested on the text BEHIND
  // the filler prefix: if the remainder is no longer small talk, it fires. A
  // wholly-pleasantry question ("Hey, how are you doing today?") stays quiet —
  // its remainder is still small talk.
  const substantialQuestion =
    raw.trimEnd().endsWith("?") && raw.trim().split(/\s+/).length >= 6;
  if (isSmallTalk(normalized)) {
    if (!substantialQuestion || isSmallTalk(stripFillerPrefix(normalized))) {
      return { fire: false, reason: "small_talk" };
    }
  }

  const question = looksLikeQuestion(raw, normalized);
  const term = hasEndTerm(raw);

  if (question) {
    return { fire: true, kind: "answer", reason: "question_detected" };
  }
  if (term) {
    return { fire: true, kind: "define", reason: "term_detected" };
  }
  if (!speakerIsUser && isAdvancementStatement(raw)) {
    return { fire: true, kind: "advance", reason: "advancement_statement" };
  }
  return { fire: false, reason: "no_trigger" };
}
