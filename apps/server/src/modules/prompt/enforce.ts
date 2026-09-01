/**
 * Deterministic voice enforcement for Nova's spoken answers (Gustavo-ratified
 * 2026-08-20 prompt-stack redesign; technique reference:
 * `.claude/skills/designing-prompt-stacks/reference/voice-enforcement.md`).
 *
 * The prompt ASKS for human speech; this module GUARANTEES the floor after
 * the model. One em dash in fifty answers still leaks through any prompt, and
 * the user reads that dash aloud as a pause that is not there — so the
 * mechanical tells (dashes, semicolons, narration, coaching labels, corporate
 * idioms, trailing offers) are rewritten by code. Word-class tells ("delve",
 * "leverage" as a verb, …) are DETECTED and logged only: swapping a word can
 * change a fact, and the ledger — not a regex — decides the next prompt fix.
 *
 * PURE on purpose: no fs, no node imports at all. It lives in
 * `modules/prompt` so the live layer's `[no-disk]` audit stays untouched.
 *
 * THE NOVA INVERSION (vs typical humanizers): Nova's output format is a
 * `Say:` label line followed by a fenced block of SPEAKABLE text, optionally
 * one more short label + fence. So ```text fences and BARE fences hold SPEECH
 * and are enforced INSIDE, while a fence carrying any other language tag
 * (```python …) is REAL code and is never touched. Inline `code` and $math$
 * are protected everywhere. Every pass is style-only, fact-preserving, and
 * idempotent — `f(f(x)) === f(x)` is pinned by `enforce.test.ts`.
 */

/** What one enforcement pass did, plus every tell DETECTED in the raw input. */
export interface EnforceSpokenResult {
  readonly text: string;
  readonly changed: boolean;
  readonly violations: string[];
  /**
   * How many DISTINCT tell bands the raw answer tripped (Gustavo-ratified
   * 2026-08-21). Blader's law: clusters are the signal, a single ordinary
   * word is not, so the score counts BANDS, never occurrences. It is the
   * trend line across prompt versions and the head-to-head number for one
   * model against another on the same ask.
   */
  readonly tellScore: number;
}

/** Say-format shape check (label present, block count, label discipline). */
export interface SayFormatCheck {
  readonly ok: boolean;
  readonly issues: string[];
}

/** Spoken length of the speakable segments only (labels/code never spoken). */
export interface SpeakableStats {
  readonly words: number;
  readonly seconds: number;
}

/** Teleprompter reading rate the seconds estimate uses (voice-enforcement §2b). */
const WORDS_PER_SECOND = 2.8;

/** Labels are glance anchors, not sentences — validator bound (format contract). */
const MAX_LABEL_CHARS = 40;

// --- Say-format line grammar ------------------------------------------------

const FENCE_OPEN = /^```(.*)$/;
const FENCE_CLOSE = /^```\s*$/;

/** A short trailing-colon line outside fences — structural, never spoken. */
function isLabelLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= MAX_LABEL_CHARS && t.endsWith(":");
}

type LineKind = "verbatim" | "speech";

/**
 * Classify every line: `speech` (speakable fence bodies + stray prose outside
 * fences) vs `verbatim` (fence markers, code-fence bodies, labels, blanks).
 * The inversion lives here: a bare or ```text fence opens SPEECH; any other
 * tag opens protected code. Reassembly is byte-exact outside speech lines.
 */
function classifyLines(lines: readonly string[]): LineKind[] {
  const kinds: LineKind[] = [];
  let state: "outside" | "speech-fence" | "code-fence" = "outside";
  for (const line of lines) {
    if (state === "outside") {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        const tag = (open[1] ?? "").trim().split(/\s+/)[0] ?? "";
        state =
          tag === "" || tag.toLowerCase() === "text"
            ? "speech-fence"
            : "code-fence";
        kinds.push("verbatim");
      } else if (line.trim() === "" || isLabelLine(line)) {
        kinds.push("verbatim");
      } else {
        kinds.push("speech");
      }
    } else if (FENCE_CLOSE.test(line)) {
      state = "outside";
      kinds.push("verbatim");
    } else {
      kinds.push(state === "speech-fence" ? "speech" : "verbatim");
    }
  }
  return kinds;
}

// --- Protected inline spans (everywhere, even inside speech) ----------------

/** Private-use sentinels: no spaces, and a literal answer cannot collide. */
const OPEN = "\uE000";
const CLOSE = "\uE001";
const RESTORE = /\uE000(\d+)\uE001/g;

const BLOCK_MATH = /\$\$[\s\S]*?\$\$/g;
const INLINE_CODE = /`[^`\n]+`/g;
/**
 * Inline math with the Pandoc guard: the content hugs its dollars (no inner
 * leading/trailing space) and the closing `$` is never glued to a digit — so
 * spoken money ("$47,500 and $40") is NEVER mistaken for a protected span.
 */
const INLINE_MATH = /\$\S(?:[^$\n]*?\S)?\$(?!\d)/g;

// --- The tell tables --------------------------------------------------------

const COACHING_PREFIX =
  /^\s*(?:say this|here['’]?s what you could say|answer|response|suggestion)\s*:\s*/i;

/** Sentence-initial source narration — the user never says where a fact lives. */
const NARRATION =
  /(^|[.!?]\s+|\n[ \t]*)(?:based on|according to|per|from)\s+(?:my|your|the|our)\s+(?:resume|profile|notes|context|documents?|script)[,:]?\s*/i;

const RANGE_DASH = /(\d)[ \t]*[—–][ \t]*(\d)/g;
const EM_DASH = /[ \t]*[—–][ \t]*/g;
const DOUBLE_DASH = /[ \t]+--[ \t]+/g;
/**
 * ASCII hyphen used AS a dash: spaced, between non-digits, mid-line. Compound
 * words ("real-time"), flags ("--dry-run"), line-start bullets and spaced
 * numeric ranges ("10 - 15") all fail the guards and survive.
 */
const ASCII_DASH = /(?<=[^\s\d]) - (?=[^\s\d])/g;

/**
 * Corporate idiom → plain speech, longest trigger first so a longer phrase is
 * never half-eaten by a shorter one. Grammatical drop-ins, and no replacement
 * contains a tell or another trigger (that is what keeps the pass idempotent).
 */
const IDIOMS: readonly (readonly [key: string, find: RegExp, say: string])[] = [
  ["proven track record", /\bproven track record\b/gi, "I've done this before"],
  [
    "actionable insights",
    /\bactionable insights\b/gi,
    "things the team can actually use",
  ],
  [
    "unique blend of",
    /\bunique blend of\b/gi,
    "the useful part of my background is",
  ],
  ["move the needle", /\bmove the needle\b/gi, "make a real difference"],
  ["best-in-class", /\bbest-in-class\b/gi, "as good as it gets"],
  // Absorb an existing "to this/that/it" so the drop-in never doubles it.
  [
    "circle back",
    /\bcircle back(?: to (?:this|that|it))?\b/gi,
    "come back to this",
  ],
  ["touch base", /\btouch base\b/gi, "talk"],
  ["synergy", /\bsynerg(?:y|ies)\b/gi, "working well together"],
];

/** A whole trailing offer/filler sentence — removed, the answer ends clean. */
const TRAILING_FILLER =
  /(^|[.!?]\s+|\n[ \t]*)(?:i hope this helps|hope that answers|let me know if you|feel free to|does that make sense|is there anything else|i['’]?d be happy to|i would be happy to|if you want,? i can|want me to)[^.!?\n]*[.!?]?[ \t]*$/i;

/**
 * Filler phrases with an exact plain-speech equivalent (blader §23). SAFE to
 * rewrite: each is a grammatical drop-in that cannot change a claim, so these
 * are the only word-level swaps this pass performs beyond the idiom table.
 */
const FILLER_SWAPS: readonly (readonly [
  key: string,
  find: RegExp,
  say: string,
])[] = [
  ["in order to", /\bin order to\b/gi, "to"],
  ["due to the fact that", /\bdue to the fact that\b/gi, "because"],
  ["at this point in time", /\bat this point in time\b/gi, "now"],
];

/**
 * "has/have/had the ability to" -> "can/could": the verb has to agree, so it
 * is its own rule rather than a row in the flat table above.
 */
const ABILITY = /\b(ha[sv]e?|had) the ability to\b/gi;

/** Curly quotes and apostrophes to straight (blader §19). Cosmetic, safe. */
const CURLY_DOUBLE = /[“”]/g;
const CURLY_SINGLE = /[‘’]/g;

/**
 * Detect-only bands (2026-08-21, from blader's catalog). Rewriting any of
 * these would change meaning or voice, so they are LOGGED and the PROMPT is
 * what gets fixed when the ledger shows a model leaking them.
 */
const DETECT_ONLY: readonly (readonly [key: string, find: RegExp])[] = [
  [
    "ad-speak",
    /\b(boasts?|vibrant|seamless|groundbreaking|renowned|breathtaking|stunning|nestled|robust|unlocks?)\b/i,
  ],
  [
    "inflation",
    /\b(a testament to|stands as|a pivotal moment|evolving landscape|indelible mark)\b/i,
  ],
  [
    "serves-as",
    /\b(serves as|stands as|represents|constitutes|functions as)\b/i,
  ],
  [
    "not-just-x",
    /\b(not just (?:a|an|about)|not only\b[^.!?]*\bbut also|not merely)\b/i,
  ],
  ["forced-three", /\w[\w '-]*,\s+\w[\w '-]*,\s+and\s+\w[\w '-]*[.!?]/i],
  [
    "qualifier-stack",
    /\b(could potentially|might arguably|possibly be argued|it's also possible)\b/i,
  ],
  [
    "staged-opener",
    /(^|[.!?]\s+)(let's (?:dive|explore|break)|here's (?:what you need|the thing)|honestly\?|real talk|look,)/i,
  ],
  [
    "fake-depth",
    /\b(the real question is|at its core|what really matters|the deeper issue|the heart of the matter)\b/i,
  ],
  [
    "generic-ending",
    /\b(the future looks bright|exciting times|a step in the right direction)\b/i,
  ],
  ["formulaic-saying", /\bis the (?:language|currency|architecture) of\b/i],
  ["curly-quotes", /[“”‘’]/],
];

/**
 * Word-class tells: LOGGED as `banned-word:<key>`, never rewritten — a word
 * swap changes meaning, and the raw-vs-shipped ledger is the improvement loop.
 * "leverage" is flagged only in verb positions (inflected forms, or followed
 * by a determiner/possessive) — best-effort, the noun stays unflagged.
 */
const BANNED_WORDS: readonly (readonly [key: string, find: RegExp])[] = [
  ["delve", /\bdelv(?:e|es|ed|ing)\b/i],
  [
    "leverage",
    /\bleverag(?:es|ed|ing)\b|\bleverage\s+(?:my|our|your|the|a|an|this|that|these|those|its|their|existing)\b/i,
  ],
  ["navigate the", /\bnavigate the\b/i],
  ["intricate", /\bintricate\b/i],
  ["tapestry", /\btapestr(?:y|ies)\b/i],
  ["moreover", /\bmoreover\b/i],
  ["furthermore", /\bfurthermore\b/i],
  ["it's important to note", /\bit['’]?s important to note\b/i],
  ["great question", /\bgreat question\b/i],
  ["certainly!", /\bcertainly!/i],
  ["in today's fast-paced world", /\bin today['’]?s fast-paced world\b/i],
  ["in the realm of", /\bin the realm of\b/i],
  // blader §7 additions (2026-08-21).
  ["testament", /\btestament\b/i],
  ["pivotal", /\bpivotal\b/i],
  ["landscape", /\blandscape\b/i],
  ["interplay", /\binterplay\b/i],
  ["garner", /\bgarner(?:s|ed|ing)?\b/i],
  ["foster", /\bfoster(?:s|ed|ing)?\b/i],
  ["underscore", /\bunderscor(?:e|es|ed|ing)\b/i],
  ["enhance", /\benhanc(?:e|es|ed|ing)\b/i],
  ["align with", /\balign(?:s|ed|ing)? with\b/i],
  ["crucial", /\bcrucial\b/i],
  ["showcase", /\bshowcas(?:e|es|ed|ing)\b/i],
];

// --- Detection (raw speakable segments; protected spans already vaulted) ----

function detectTells(text: string, violations: Set<string>): void {
  if (COACHING_PREFIX.test(text)) violations.add("coaching-prefix");
  if (NARRATION.test(text)) violations.add("narration");
  if (/[—–]/.test(text)) violations.add("em-dash");
  if (text.search(DOUBLE_DASH) !== -1) violations.add("double-dash");
  if (text.search(ASCII_DASH) !== -1) violations.add("ascii-dash");
  if (text.includes(";")) violations.add("semicolon");
  for (const [key, find] of IDIOMS) {
    if (text.search(find) !== -1) violations.add(`idiom:${key}`);
  }
  if (TRAILING_FILLER.test(text)) violations.add("filler-ending");
  for (const [key, find] of FILLER_SWAPS) {
    if (text.search(find) !== -1) violations.add(`filler:${key}`);
  }
  if (ABILITY.test(text)) violations.add("filler:has the ability to");
  for (const [key, find] of DETECT_ONLY) {
    if (find.test(text)) violations.add(key);
  }
  if (isUniformRhythm(text)) violations.add("uniform-rhythm");
  for (const [key, find] of BANNED_WORDS) {
    if (find.test(text)) violations.add(`banned-word:${key}`);
  }
}

// --- The rewrite passes -----------------------------------------------------

/** Upper-case the first letter after a strip so the sentence still reads. */
function capitalizeStart(text: string): string {
  return text.replace(
    /^(\s*)(\p{Ll})/u,
    (_m, lead: string, ch: string) => lead + ch.toUpperCase(),
  );
}

/** Loop to a fixpoint: "Answer: Say this: …" fully unwraps in ONE call. */
function stripCoachingPrefix(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(COACHING_PREFIX, "");
    if (next === current) return current;
    current = capitalizeStart(next);
  }
}

/** Also a fixpoint loop — stacked narration must not need a second call. */
function stripNarration(text: string): string {
  let current = text;
  for (;;) {
    const m = NARRATION.exec(current);
    if (!m) return current;
    const head = current.slice(0, m.index) + (m[1] ?? "");
    const tail = current
      .slice(m.index + m[0].length)
      .replace(/^\p{Ll}/u, (ch) => ch.toUpperCase());
    current = head + tail;
  }
}

function applyDashRules(text: string): string {
  // Numeric ranges keep a plain hyphen ("3—5" → "3-5"), never become a comma.
  let t = text.replace(RANGE_DASH, "$1-$2");
  // Everything else: an em/en dash is an unspeakable pause → spoken comma.
  t = t.replace(EM_DASH, ", ");
  t = t.replace(DOUBLE_DASH, ", ");
  t = t.replace(ASCII_DASH, ", ");
  return t;
}

function applySemicolonRules(text: string): string {
  // Line-end first, so the sentence-split rule below never eats a newline.
  let t = text.replace(/;[ \t]*$/gm, ".");
  t = t.replace(/;\s+(\w)/g, (_m, ch: string) => `. ${ch.toUpperCase()}`);
  return t;
}

function applyIdioms(text: string): string {
  let t = text;
  for (const [, find, say] of IDIOMS) {
    t = t.replace(find, (m) =>
      /^\p{Lu}/u.test(m) ? say.charAt(0).toUpperCase() + say.slice(1) : say,
    );
  }
  return t;
}

/** Peel trailing filler sentences until the last sentence carries content. */
function stripTrailingFiller(text: string): string {
  let current = text;
  for (;;) {
    const m = TRAILING_FILLER.exec(current);
    if (!m) return current;
    current = (current.slice(0, m.index) + (m[1] ?? "")).replace(/\s+$/, "");
  }
}

/** Rewrite artifacts: never let a mechanical fix leave mechanical residue. */
function tidy(text: string): string {
  let t = text.replace(/,[ \t]*(?:,[ \t]*)+/g, ", "); // ",," / ", ,"
  t = t.replace(/,[ \t]*([.!?])/g, "$1"); // "word, ." → "word."
  t = t.replace(/(^|\n)[ \t]*,[ \t]*/g, "$1"); // a dash that opened a line
  t = t.replace(/ {2,}/g, " ");
  t = t.replace(/[ \t]+$/gm, "");
  return t;
}

/**
 * Rhythm tell (blader "human details to keep": real writing alternates short
 * and long; AI trends to an even mid-length cadence). Flagged only with
 * enough sentences to judge, and only when NONE is short: a single long
 * answer is not a tell, a wall of same-size sentences is.
 */
function isUniformRhythm(text: string): boolean {
  const lengths = text
    .split(/[.!?]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean).length)
    .filter((n) => n > 0);
  if (lengths.length < 4) return false;
  return lengths.every((n) => n >= 9);
}

/** The safe word-level swaps: grammatical drop-ins, never a claim change. */
function applyFillerSwaps(text: string): string {
  let t = text;
  for (const [, find, say] of FILLER_SWAPS) {
    t = t.replace(find, (m) =>
      /^\p{Lu}/u.test(m) ? say.charAt(0).toUpperCase() + say.slice(1) : say,
    );
  }
  t = t.replace(ABILITY, (_m, verb: string) => {
    const word = verb.toLowerCase() === "had" ? "could" : "can";
    return /^\p{Lu}/u.test(verb)
      ? word.charAt(0).toUpperCase() + word.slice(1)
      : word;
  });
  return t;
}

/** Straight quotes: a chatbot artifact, never the speaker's choice. */
function normalizeQuotes(text: string): string {
  return text.replace(CURLY_DOUBLE, '"').replace(CURLY_SINGLE, "'");
}

/**
 * One speech segment through the whole pipeline: vault protected inline spans,
 * detect tells on the RAW text, rewrite the mechanical ones, restore. Order
 * matters — coaching before narration (the label hides the narration behind
 * it), dashes before idioms ("best-in-class" must still be intact to match),
 * filler last-but-tidy (it needs final sentence positions to be settled).
 */
function enforceSpeechSegment(raw: string, violations: Set<string>): string {
  // Defence: strip stray sentinel chars so an answer cannot forge a vault slot.
  let text = raw.split(OPEN).join("").split(CLOSE).join("");
  const vault: string[] = [];
  const protect = (find: RegExp): void => {
    text = text.replace(find, (m) => {
      vault.push(m);
      return `${OPEN}${String(vault.length - 1)}${CLOSE}`;
    });
  };
  protect(BLOCK_MATH);
  protect(INLINE_CODE);
  protect(INLINE_MATH);

  detectTells(text, violations);

  text = stripCoachingPrefix(text);
  text = stripNarration(text);
  text = applyDashRules(text);
  text = applySemicolonRules(text);
  text = applyIdioms(text);
  text = applyFillerSwaps(text);
  text = normalizeQuotes(text);
  text = stripTrailingFiller(text);
  text = tidy(text);

  return text.replace(
    RESTORE,
    (_m, index: string) => vault[Number(index)] ?? "",
  );
}

// --- Public surface ---------------------------------------------------------

/**
 * The authoritative done-pass: enforce inside every speakable segment, leave
 * labels, code fences, inline code and math byte-exact, and report every tell
 * DETECTED in the raw input's speakable segments (band ids like "em-dash",
 * "banned-word:delve") — including the word-class tells that are logged, not
 * rewritten. Idempotent and fact-preserving; `changed` is `output !== input`.
 */
export function enforceSpoken(text: string): EnforceSpokenResult {
  const violations = new Set<string>();
  const lines = text.split("\n");
  const kinds = classifyLines(lines);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (kinds[i] !== "speech") {
      out.push(lines[i] ?? "");
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && kinds[i] === "speech") i += 1;
    out.push(
      enforceSpeechSegment(lines.slice(start, i).join("\n"), violations),
    );
  }
  const result = out.join("\n");
  return {
    text: result,
    changed: result !== text,
    violations: [...violations],
    tellScore: violations.size,
  };
}

/**
 * Streaming-safe cheap variant for delta flushes: the dash swaps only, no
 * fence parsing (a chunk boundary can split a fence marker, so the done-pass
 * above stays authoritative). Harmless on code-looking chunks: `--dry-run`
 * style flags have no space after the dashes and never match.
 */
export function enforceChunk(chunk: string): string {
  if (chunk === "") return chunk;
  let t = chunk.replace(RANGE_DASH, "$1-$2");
  t = t.replace(EM_DASH, ", ");
  t = t.replace(DOUBLE_DASH, ", ");
  return t;
}

/**
 * Validate the Say-format shape: a `Say:` label before the first fence, at
 * most two labeled fence blocks, and short colon-terminated label lines.
 * Issues are stable ids the conductor can log; `ok` means zero issues.
 */
export function validateSayFormat(text: string): SayFormatCheck {
  const issues: string[] = [];
  const lines = text.split("\n");
  let inFence = false;
  // Each fence block's label = the nearest preceding non-blank outside line.
  let pending: string | null = null;
  const labels: (string | null)[] = [];
  for (const line of lines) {
    if (inFence) {
      if (FENCE_CLOSE.test(line)) inFence = false;
      continue;
    }
    if (FENCE_OPEN.test(line)) {
      inFence = true;
      labels.push(pending);
      pending = null;
      continue;
    }
    if (line.trim() !== "") pending = line.trim();
  }

  if (labels.length === 0) {
    issues.push("no-fence");
  } else {
    const first = labels[0];
    if (first === null || first === undefined || !/^say:$/i.test(first)) {
      issues.push("missing-say-label");
    }
    if (labels.length > 2) issues.push("too-many-blocks");
    labels.forEach((label, index) => {
      if (label === null) {
        if (index > 0) issues.push("unlabeled-block");
        return;
      }
      if (!label.endsWith(":")) issues.push("label-missing-colon");
      else if (label.length > MAX_LABEL_CHARS) issues.push("label-too-long");
    });
  }
  if (inFence) issues.push("unclosed-fence");
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

/**
 * Hard format break (no fence at all): wrap the whole trimmed text into the
 * canonical Say block so the pill still renders a wrapped highlight. Text
 * that already carries a fence is returned untouched — repair, never nest.
 */
export function repairToSayBlock(text: string): string {
  if (/^```/m.test(text)) return text;
  return `Say:\n\`\`\`text\n${text.trim()}\n\`\`\``;
}

/**
 * Words/seconds over the SPEAKABLE segments only — labels, code fences,
 * inline code and math are silent. Stats only in v1: trimming is a later
 * product call, so nothing here ever shortens an answer.
 */
export function speakableStats(text: string): SpeakableStats {
  const lines = text.split("\n");
  const kinds = classifyLines(lines);
  const speech = lines.filter((_, i) => kinds[i] === "speech").join("\n");
  const spoken = speech
    .replace(BLOCK_MATH, " ")
    .replace(INLINE_CODE, " ")
    .replace(INLINE_MATH, " ");
  const words = spoken
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, seconds: Math.round((words / WORDS_PER_SECOND) * 10) / 10 };
}
