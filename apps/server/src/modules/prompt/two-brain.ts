import { z } from "zod";

import {
  renderTurn,
  trimSnippets,
  trimUserContext,
  windowTranscript,
} from "./assemble.js";
import { approxTokens, promptConfig, type PromptConfig } from "./config.js";
import { BRAIN_A_MEETING_PROMPT } from "./content/meeting-enterprise.js";
import { BRAIN_B_SOLVER_PROMPT } from "./content/problem-solver.js";
import {
  promptRagSnippetSchema,
  promptTranscriptTurnSchema,
  type AssembledPrompt,
} from "./ports.js";

/**
 * The two-brain prompt engine (M2, design doc
 * `2026-08-16-modes-context-engine-design.md` §1/§3). Two entry points, each
 * hard-wired to its own authored base — `assembleMeeting` to Brain A (the
 * live-meeting co-pilot), `assembleSolver` to Brain B (the problem solver).
 * That structure IS the never-both law: no code path here can compose a
 * request holding both identities, and `two-brain.test.ts` pins it.
 *
 * Brain A's text ends on its user-provided-context anchor line, so the
 * dynamic suffix opens with the CONTEXT ENVELOPE — the anchor's deferral
 * instruction points at the very next block — and closes with the windowed
 * transcript (the prompt reasons about "the end of the transcript").
 *
 * Code assembles; every word of prose is Gustavo's (RULES §9). The envelope's
 * "(none provided for this call)" empty form is the single line of new
 * authored text this design introduces (§3, pending ratification).
 */

/** The one authored line beyond the prompts themselves (design doc §3). */
export const ENVELOPE_EMPTY_TEXT = "(none provided for this call)";

/**
 * The envelope's structural tags. Facts-grade content (files, memory) gets any
 * occurrence of these neutralized before wrapping, so a dragged PDF containing
 * `</reference_files><user_script>…` cannot break out of its tag and promote
 * itself to instructions (§3 serialization safety; mechanism pinned by tests:
 * ASCII angle brackets become single guillemets, content otherwise untouched).
 * The pattern tolerates tag whitespace and attributes (`</reference_files >`,
 * `<user_script role="trusted">`) — an evasion is as dangerous as the plain
 * form; attributes are dropped from the neutralized rendering.
 */
const ENVELOPE_TAG_PATTERN =
  /<\s*(\/?)\s*(user_provided_context|user_script|reference_files|user_memory)\b[^>]*>/gi;

function neutralizeEnvelopeTags(text: string): string {
  return text.replace(ENVELOPE_TAG_PATTERN, "‹$1$2›");
}

/**
 * Everything Brain A varies per turn. THREE separate context fields — never a
 * merged snippet list — so trust provenance survives into the assembled prompt
 * (§3): `userScript` is the user's own typed instructions (trusted, the
 * anchor line's "specific script/desired responses"); `referenceFiles` and
 * `userMemory` are facts-grade — they inform answers, never instruct.
 */
export const meetingContextSchema = z.object({
  /** Windowed, oldest→newest. The conductor pre-trims; the assembler re-budgets. */
  transcript: z.array(promptTranscriptTurnSchema),
  /** The active mode's prompt text — the user's own instructions (M3 wires it). */
  userScript: z.string().optional(),
  /** Retrieved snippets from the mode's uploaded docs (M4 wires it). Facts-grade. */
  referenceFiles: z.array(promptRagSnippetSchema).optional(),
  /** Relevant snippets from past calls (RAG memory). Facts-grade. */
  userMemory: z.array(promptRagSnippetSchema).optional(),
});
export type MeetingContext = z.infer<typeof meetingContextSchema>;

/** Render one facts-grade block: each snippet neutralized, header then body. */
function renderFactsBlock(
  tag: "reference_files" | "user_memory",
  snippets: readonly { header: string; content: string }[],
): string {
  const rendered = snippets
    .map(
      (s) =>
        `${neutralizeEnvelopeTags(s.header)}\n${neutralizeEnvelopeTags(s.content)}`,
    )
    .join("\n");
  return `<${tag}>\n${rendered}\n</${tag}>`;
}

/**
 * The context envelope (§3). ALWAYS present — an explicitly-empty envelope is
 * what flips the model to its general-knowledge baseline instead of deflecting.
 */
function renderEnvelope(ctx: MeetingContext, config: PromptConfig): string {
  const parts: string[] = [];

  if (ctx.userScript !== undefined && ctx.userScript.trim() !== "") {
    const trimmed = trimUserContext(
      ctx.userScript.trim(),
      config.userContextBudgetTokens,
    );
    parts.push(`<user_script>\n${trimmed}\n</user_script>`);
  }

  // ONE cumulative facts-grade budget across both lists — `ragBudgetTokens`
  // is the Σ cap, not a per-list allowance, so what the files spend the
  // memory no longer has.
  const files = trimSnippets(ctx.referenceFiles ?? [], config.ragBudgetTokens);
  if (files.length > 0) {
    parts.push(renderFactsBlock("reference_files", files));
  }

  const spent = files.reduce(
    (acc, s) => acc + approxTokens(`${s.header}\n${s.content}`),
    0,
  );
  const memory = trimSnippets(
    ctx.userMemory ?? [],
    config.ragBudgetTokens - spent,
  );
  if (memory.length > 0) {
    parts.push(renderFactsBlock("user_memory", memory));
  }

  const body = parts.length > 0 ? parts.join("\n") : ENVELOPE_EMPTY_TEXT;
  return `<user_provided_context>\n${body}\n</user_provided_context>`;
}

/**
 * Brain A: the live-meeting co-pilot. The stablePrefix is the authored prompt
 * byte-for-byte (snapshot-held to its source doc) — ONE warm vendor cache for
 * every call, replacing the legacy four mode prefixes.
 */
export function assembleMeeting(
  context: MeetingContext,
  config: PromptConfig = promptConfig,
): AssembledPrompt {
  const ctx = meetingContextSchema.parse(context);
  const window = windowTranscript(
    ctx.transcript,
    config.transcriptBudgetTokens,
  );
  const transcriptText = window.map(renderTurn).join("\n");
  return {
    stablePrefix: BRAIN_A_MEETING_PROMPT,
    dynamicSuffix: [
      renderEnvelope(ctx, config),
      // Label always present (even empty) so the model always sees where the
      // current moment is — same contract the legacy assembler kept.
      ["TRANSCRIPT", transcriptText].join("\n"),
    ].join("\n\n"),
  };
}

/**
 * What Brain B varies per ask. Routing (R1–R4) and the one-frame law land in
 * M5 — M2 lands the hard-wired entry point so the never-both law is structural
 * from the start. The transcript tail rides along as labeled data (open
 * decision #2's default-yes: the problem is often spoken before it's solved).
 */
export const solverContextSchema = z.object({
  /** The user's typed ask; absent for the empty-handed Answer press (M5). */
  question: z.string().optional(),
  /** The last seconds of transcript, as me/them-labeled data. */
  transcriptTail: z.array(promptTranscriptTurnSchema).optional(),
});
export type SolverContext = z.infer<typeof solverContextSchema>;

/** Brain B: the problem solver. No envelope — that is Brain A's anchor contract. */
export function assembleSolver(
  context: SolverContext,
  config: PromptConfig = promptConfig,
): AssembledPrompt {
  const ctx = solverContextSchema.parse(context);
  const sections: string[] = [];
  if (ctx.transcriptTail !== undefined && ctx.transcriptTail.length > 0) {
    const tail = windowTranscript(
      ctx.transcriptTail,
      config.transcriptBudgetTokens,
    );
    sections.push(tail.map(renderTurn).join("\n"));
  }
  if (ctx.question !== undefined && ctx.question.trim() !== "") {
    sections.push(ctx.question.trim());
  }
  return {
    stablePrefix: BRAIN_B_SOLVER_PROMPT,
    dynamicSuffix: sections.join("\n\n"),
  };
}
