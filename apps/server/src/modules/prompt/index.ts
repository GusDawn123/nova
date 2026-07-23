/**
 * Public surface of modules/prompt (Phase 7). One pure `assemble(mode, context)`
 * + the boundary types/config. The verbatim system-prompt content stays private
 * to `content/` — consumers never import prose directly, only the assembler.
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
