/**
 * Public surface of modules/prompt. As of M2 the live path runs the two-brain
 * engine — `assembleMeeting` (Brain A) / `assembleSolver` (Brain B), each
 * hard-wired to its own authored base (the never-both law). The prose stays
 * private to `content/` — consumers never import prompt text, only assemblers.
 *
 * The legacy `assemble(mode, context)` + `library/` stay exported but UNWIRED
 * (nothing on the live path calls them) — kept as the reference for what the
 * mode-block prompts used to say, the same retirement `content/system-prompt.ts`
 * got before them.
 */

export { assemble } from "./assemble.js";

export {
  assembleMeeting,
  assembleSolver,
  meetingContextSchema,
  solverContextSchema,
  ENVELOPE_EMPTY_TEXT,
  type MeetingContext,
  type SolverContext,
} from "./two-brain.js";

export {
  promptModeSchema,
  promptContextSchema,
  promptTranscriptTurnSchema,
  promptRagSnippetSchema,
  type PromptMode,
  type PromptContext,
  type PromptTranscriptTurn,
  type PromptRagSnippet,
  type AssembledPrompt,
} from "./ports.js";

export {
  promptConfigSchema,
  promptConfig,
  approxTokens,
  type PromptConfig,
} from "./config.js";
