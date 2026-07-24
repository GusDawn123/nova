import type { LlmProvider } from "../ports.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

/**
 * OpenAI provider adapter (official `openai` SDK), a thin wrapper over the
 * shared OpenAI-compatible engine — it only pins the provider id and a
 * cheap/fast default model.
 */

/** A cheap/fast current model — see docs before changing (do not guess IDs).
 * Lineage: gpt-4o-mini (2024, Phase 2 default) → gpt-5.4-mini (2026-07-23
 * refresh; released 2026-03; $0.75/$4.50 per 1M verified on OpenAI's pricing
 * page — the price book must move in lockstep, adr-0004 addendum). */
const DEFAULT_MODEL = "gpt-5.4-mini";

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
    // gpt-5.x minis are reasoning-capable; pin reasoning OFF (adr-0004 §4 —
    // the TTFT lever, and reasoning tokens would eat the small
    // max_completion_tokens cap). PROBED 2026-07-23: gpt-5.4-mini accepts
    // 'none'|'low'|'medium'|'high'|'xhigh' and REJECTS 'minimal' with a 400;
    // "none" verified to yield reasoning_tokens: 0.
    reasoningEffort: "none",
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
  });
}
