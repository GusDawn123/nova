import type { LlmProvider } from "../ports.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

/**
 * OpenAI provider adapter (official `openai` SDK), a thin wrapper over the
 * shared OpenAI-compatible engine — it only pins the provider id and a
 * cheap/fast default model.
 */

/** The current model — see docs before changing (do not guess IDs).
 * Lineage: gpt-4o-mini (2024, Phase 2 default) → gpt-5.4-mini (2026-07-23
 * refresh) → gpt-5.6-terra (2026-08-17, Gustavo's pick: "decently smart,
 * reasoning low" — Terra is the balanced GPT-5.6 tier, ~GPT-5.5 quality at
 * $2/$12 per 1M, GA 2026-07-09; id verified against the model list on our
 * key — the price book must move in lockstep, adr-0004 addendum). */
const DEFAULT_MODEL = "gpt-5.6-terra";

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
    // Reasoning LOW (Gustavo, 2026-08-17: decently smart, reasoning low) —
    // enough to plan an answer, cheap enough for the live loop. The gpt-5.x
    // effort ladder is 'none'|'low'|'medium'|'high'(|'xhigh'); 'minimal' was
    // probed REJECTED (400) on this family 2026-07-23.
    reasoningEffort: "low",
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
  });
}
