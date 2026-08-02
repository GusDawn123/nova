/**
 * Public surface of modules/prompt (Phase 7). One pure `assemble(mode, context)`
 * + the boundary types/config. The prose stays private to `library/` — consumers
 * pick a mode and never import prompt text directly, only the assembler.
 */

export { assemble } from "./assemble.js";

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
