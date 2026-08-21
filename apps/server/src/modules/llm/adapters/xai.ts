import type { LlmProvider } from "../ports.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

/**
 * xAI (Grok) provider adapter. xAI exposes an OpenAI-compatible API, so this
 * is the groq pattern verbatim: the `openai` SDK against xAI's base URL — the
 * whole adapter is the id + default model + base URL.
 */

/** The current model — see docs before changing (do not guess IDs).
 * grok-4.1-fast (added 2026-08-20 for the humanized-speech bake-off: top
 * LMArena human-preference + EQ-Bench Elo of the 2026 field, TTFT in the
 * live class). NOT yet probed live — no XAI_API_KEY on this machine at
 * adapter time; PROBE the id and the price book entry the day the key
 * lands, before trusting either. */
const DEFAULT_MODEL = "grok-4.1-fast";
/** xAI's OpenAI-compatible endpoint. */
const XAI_BASE_URL = "https://api.x.ai/v1";

export interface XaiProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  /** Sampling temperature; omitted = vendor default (see openai-compatible). */
  temperature?: number;
}

export function createXaiProvider(opts: XaiProviderOptions): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "xai",
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    baseURL: XAI_BASE_URL,
    // No reasoningEffort: grok-4.1-fast is the non-reasoning live tier and
    // the param is unprobed on xAI's endpoint — omit until proven accepted.
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
  });
}
