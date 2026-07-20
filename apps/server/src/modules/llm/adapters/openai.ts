import type { LlmProvider } from "../ports.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

/**
 * OpenAI provider adapter (official `openai` SDK), a thin wrapper over the
 * shared OpenAI-compatible engine — it only pins the provider id and a
 * cheap/fast default model.
 */

/** A cheap/fast current model — see docs before changing (do not guess IDs). */
const DEFAULT_MODEL = "gpt-4o-mini";

export interface OpenAiProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
}

export function createOpenAiProvider(opts: OpenAiProviderOptions): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "openai",
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
  });
}
