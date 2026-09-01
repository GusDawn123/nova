import { approxTokens, promptConfig, type PromptConfig } from "./config.js";
import {
  MODES,
  SYSTEM_PROMPT,
  type ModePrompt,
  type PromptExample,
} from "./library/index.js";
import {
  promptContextSchema,
  type AssembledPrompt,
  type PromptContext,
  type PromptMode,
  type PromptRagSnippet,
  type PromptTranscriptTurn,
} from "./ports.js";

/**
 * The one pure entry point of modules/prompt: split the byte-stable system
 * prompt (the cacheable prefix) from the per-turn dynamic suffix. No I/O, no
 * clock, no vendor — the conductor calls it every trigger and streams the result
 * through the llm router. Code assembles; every word of prose comes from
 * `library/` (RULES §9).
 *
 * The prefix is SYSTEM_PROMPT plus, for a picked mode, that one mode's block.
 * The mode is fixed at `session.start` and never changes mid-call, so the prefix
 * is byte-stable per session exactly as it was when there was only one of them.
 *
 * Suffix layout (transcript LAST — the prompt reasons about "the end of the
 * transcript"):
 *   1. user context   — delimited DATA following the prefix's own
 *                        "User-provided context (defer to this…)" trailer
 *   2. memory snippets — RAG grounding, ranked, under a hard token budget
 *   3. transcript      — windowed, most-recent turns, ends the whole prompt
 * Any block absent → its section is omitted entirely (no empty labels).
 */

/** Delimiters that fence untrusted DATA so it can't blend into instructions. */
const BLOCK_OPEN = "<<<";
const BLOCK_CLOSE = ">>>";

/** Map a diarized label onto the prompt's me:/them: convention, else pass raw. */
function speakerLabel(speaker: string | null): string {
  if (speaker === null || speaker === "") return "them";
  const lower = speaker.toLowerCase();
  if (lower === "me" || lower === "them" || lower === "assistant") return lower;
  return speaker;
}

/** Render one transcript turn as `label: text`. */
export function renderTurn(turn: PromptTranscriptTurn): string {
  return `${speakerLabel(turn.speaker)}: ${turn.text}`;
}

/**
 * Keep the most-recent transcript turns whose cumulative tokens stay within
 * `budget` (oldest dropped first — the tail is the current moment). Returns the
 * kept turns in chronological order. Exported for `two-brain.ts` (M2), which
 * shares the windowing/budget mechanics while owning its own prompt bases.
 */
export function windowTranscript(
  turns: PromptTranscriptTurn[],
  budget: number,
): PromptTranscriptTurn[] {
  const kept: PromptTranscriptTurn[] = [];
  let acc = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const cost = approxTokens(renderTurn(turn));
    if (acc + cost > budget && kept.length > 0) break;
    kept.push(turn);
    acc += cost;
    // A single turn bigger than the whole budget is still kept once (the current
    // moment must never vanish); further turns then stop on the next iteration.
    if (acc > budget) break;
  }
  return kept.reverse();
}

/**
 * Keep leading snippets whose cumulative tokens fit `budget` (ranked
 * best-first). Generic over the snippet shape (2026-08-20) so the composer's
 * kind-tagged evidence entries survive the trim with their `kind` intact —
 * the budget math and behavior are unchanged.
 */
export function trimSnippets<T extends PromptRagSnippet>(
  snippets: T[],
  budget: number,
): T[] {
  const kept: T[] = [];
  let acc = 0;
  for (const snippet of snippets) {
    const cost = approxTokens(`${snippet.header}\n${snippet.content}`);
    if (acc + cost > budget) break;
    kept.push(snippet);
    acc += cost;
  }
  return kept;
}

/** Truncate user context to a token budget (chars), never dropping it whole. */
export function trimUserContext(text: string, budget: number): string {
  const maxChars = budget * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * Assemble the prompt for one turn. `mode` is the user's pick from the Live
 * screen, carried on `session.start`. The context boundary is zod-parsed
 * (RULES §1).
 */
export function assemble(
  mode: PromptMode,
  context: PromptContext,
  config: PromptConfig = promptConfig,
): AssembledPrompt {
  // Parse the boundary — hostile/garbled input never reaches assembly untyped.
  const ctx = promptContextSchema.parse(context);

  // `mode` is typed to the wire set; the record keeps future modes honest —
  // adding an enum member without its library block breaks the build here.
  const stablePrefix = MODE_PREFIXES[mode];

  const sections: string[] = [];

  if (ctx.userContext !== undefined && ctx.userContext.trim() !== "") {
    const trimmed = trimUserContext(
      ctx.userContext.trim(),
      config.userContextBudgetTokens,
    );
    sections.push(
      ["USER CONTEXT", `${BLOCK_OPEN}\n${trimmed}\n${BLOCK_CLOSE}`].join("\n"),
    );
  }

  const snippets = trimSnippets(ctx.ragSnippets ?? [], config.ragBudgetTokens);
  if (snippets.length > 0) {
    const rendered = snippets
      .map((s) => `${BLOCK_OPEN}\n${s.header}\n${s.content}\n${BLOCK_CLOSE}`)
      .join("\n");
    sections.push(["RELEVANT CONTEXT FROM MEMORY", rendered].join("\n"));
  }

  const window = windowTranscript(
    ctx.transcript,
    config.transcriptBudgetTokens,
  );
  const transcriptText = window.map(renderTurn).join("\n");
  // Transcript label is always present (even when empty) so the model always
  // sees where the current moment is.
  sections.push(["TRANSCRIPT", transcriptText].join("\n"));

  return { stablePrefix, dynamicSuffix: sections.join("\n\n") };
}

/** One few-shot demonstration, in the same `them:`/`me:` shape as the transcript. */
function renderExample(example: PromptExample, index: number): string {
  return [
    `EXAMPLE ${String(index + 1)}`,
    example.transcript,
    "",
    "A good answer:",
    example.response,
  ].join("\n");
}

/**
 * One mode's block: its rules, the SHAPE of the answer, then its few-shot. The
 * examples ship here rather than in the system prompt on purpose — a transcript
 * sample in the always-on prefix is paid for on every call in every mode.
 */
function renderMode(mode: ModePrompt): string {
  return [
    `MODE: ${mode.label.toUpperCase()}`,
    mode.directive,
    ["ANSWER STRUCTURE", mode.answerStructure].join("\n"),
    ...mode.examples.map(renderExample),
  ].join("\n\n");
}

/** SYSTEM_PROMPT, then this mode's block. Byte-stable for the life of a session. */
function prefixFor(mode: ModePrompt): string {
  return [SYSTEM_PROMPT, renderMode(mode)].join("\n\n");
}

/**
 * The stablePrefix per mode, built ONCE at module load.
 *
 * A `Record<PromptMode, string>` so a new wire mode without a library block is a
 * compile error — exhaustiveness without an unreachable switch default. Mode is
 * locked for a session, so each of these is byte-identical across every turn of
 * every call that picked it, which is what the vendor prompt cache keys on
 * (adr-0004 §6): four warm prefixes rather than one.
 */
const MODE_PREFIXES: Record<PromptMode, string> = {
  // "general" is the universal prompt ALONE — the deliberate absence of a domain
  // block, not a missing one.
  general: SYSTEM_PROMPT,
  behavioral: prefixFor(MODES.behavioral),
  technical: prefixFor(MODES.technical),
  finance: prefixFor(MODES.finance),
};
