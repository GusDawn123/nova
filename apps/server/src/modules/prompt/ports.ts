import { z } from "zod";
import { liveModeSchema } from "@nova/shared";

/**
 * modules/prompt boundary types (Phase 7). The module is PURE: one
 * `assemble(mode, context)` that splits the authored, byte-stable system prompt
 * (the cacheable `stablePrefix`) from the only uncached tokens (the
 * `dynamicSuffix`: windowed transcript + RAG snippets under a hard token budget
 * + hard-guarded user context). Code assembles; code NEVER writes prose
 * (design: live-pipeline.md §modules/prompt; adr-0004 §6).
 */

/**
 * The prompt mode selects which domain block joins the always-on system prompt:
 * `general` is the system prompt alone, the other three each add one block from
 * `library/modes/`.
 *
 * It is the WIRE enum re-exported, not a twin: the value arrives on
 * `session.start` from the phone's picker, so a second declaration here could
 * accept a mode the client cannot send (or reject one it can). `library.test.ts`
 * closes the loop from the other side by proving the library has a block for
 * every wire mode except `general`.
 */
export const promptModeSchema = liveModeSchema;
export type PromptMode = z.infer<typeof promptModeSchema>;

/**
 * One windowed transcript turn for the dynamic suffix. `speaker` is the diarized
 * label the STT vendor emitted (or null); the assembler maps it onto the
 * prompt's `me:`/`them:` convention when it can, else passes the raw label.
 */
export const promptTranscriptTurnSchema = z.object({
  speaker: z.string().nullable(),
  text: z.string(),
});
export type PromptTranscriptTurn = z.infer<typeof promptTranscriptTurnSchema>;

/** A grounding snippet retrieved from the user's RAG memory (header + body). */
export const promptRagSnippetSchema = z.object({
  header: z.string(),
  content: z.string(),
});
export type PromptRagSnippet = z.infer<typeof promptRagSnippetSchema>;

/**
 * Everything that varies per turn. Parsed at the boundary (RULES §1). All three
 * data blocks are optional except the transcript, which is the current moment
 * the prompt reasons about ("the end of the transcript").
 */
export const promptContextSchema = z.object({
  /** Windowed, oldest→newest. The conductor pre-trims; the assembler re-budgets. */
  transcript: z.array(promptTranscriptTurnSchema),
  /** Ranked grounding snippets (best first); trimmed to the RAG token budget. */
  ragSnippets: z.array(promptRagSnippetSchema).optional(),
  /**
   * User-provided context (profile / scripts / desired responses). HARD-GUARDED:
   * it lands in the dynamic suffix as clearly delimited DATA, always AFTER the
   * byte-stable prefix that owns identity + security, so it can never override
   * them (design: live-pipeline.md §modules/prompt).
   */
  userContext: z.string().optional(),
});
export type PromptContext = z.infer<typeof promptContextSchema>;

/**
 * The assembler's output. `stablePrefix` is byte-identical across every turn of
 * a session (snapshot-test enforced) so the vendor prompt cache holds;
 * `dynamicSuffix` is the only part that changes.
 */
export interface AssembledPrompt {
  readonly stablePrefix: string;
  readonly dynamicSuffix: string;
}
