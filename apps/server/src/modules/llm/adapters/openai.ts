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
 * $2/$12 per 1M, GA 2026-07-09) → REVERTED to gpt-5.4-mini (2026-08-19,
 * Gustavo: keep the old models; id re-probed LIVE on our key the same day and
 * answering — $0.75/$4.50 per 1M, the price book must move in lockstep,
 * adr-0004 addendum). */
const DEFAULT_MODEL = "gpt-5.4-mini";

export interface OpenAiProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  /** Sampling temperature; omitted = vendor default (see openai-compatible). */
  temperature?: number;
}

export function createOpenAiProvider(opts: OpenAiProviderOptions): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "openai",
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    // Reasoning OFF via "none" — the 2026-07-23 setting, restored with the
    // 2026-08-19 model revert (adr-0004 §4: reasoning off at the adapter layer
    // is the single biggest TTFT lever). PROBED 2026-07-23: gpt-5.4-mini
    // accepts 'none'|'low'|'medium'|'high'|'xhigh' and REJECTS 'minimal' with
    // a 400; "none" verified to yield reasoning_tokens: 0. Re-probed
    // 2026-08-19: still accepted.
    reasoningEffort: "none",
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
  });
}
