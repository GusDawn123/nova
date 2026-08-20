import type { LlmProvider } from "../ports.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

/**
 * Groq provider adapter. Groq exposes an OpenAI-compatible API, so we reuse the
 * `openai` SDK against Groq's base URL rather than pulling in a second vendor
 * dependency — the whole adapter is the id + default model + base URL.
 */

/** A cheap/fast current model — see docs before changing (do not guess IDs). */
const DEFAULT_MODEL = "llama-3.1-8b-instant";
/** Groq's OpenAI-compatible endpoint. */
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export interface GroqProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  /** Sampling temperature; omitted = vendor default (see openai-compatible). */
  temperature?: number;
}

export function createGroqProvider(opts: GroqProviderOptions): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "groq",
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    baseURL: GROQ_BASE_URL,
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
  });
}
