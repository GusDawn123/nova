import { createAnthropicProvider } from "./adapters/anthropic.js";
import { createGoogleProvider } from "./adapters/google.js";
import { createGroqProvider } from "./adapters/groq.js";
import { createOpenAiProvider } from "./adapters/openai.js";
import type { LlmProvider } from "./ports.js";

/**
 * The env-driven provider factory — the wiring seam a later task hangs the HTTP
 * transport off. It builds only the providers whose API key is present, in the
 * config default failover order (anthropic → openai → google → groq), so the
 * server boots with whatever subset is configured (or none at all).
 */

/**
 * The env keys this module reads. Structural (not the whole boot `Env`) so a
 * caller passes its already-parsed env without a dependency cycle; all optional
 * — the server must boot without any provider key.
 */
export interface LlmProviderEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GROQ_API_KEY?: string;
}

/** Per-call-site knobs applied to every provider the factory builds. */
export interface LlmProviderOptions {
  /**
   * Output-token ceiling for every provider built here. Omitted → each
   * adapter's own default (1024). The live wiring RAISES this: the authored
   * Brain A prompt mandates fully-commented code + detailed explanations,
   * which a 1024-token ceiling silently squeezes out of the answer — the
   * model compresses to fit its budget (live repro 2026-08-17). Cost is per
   * token actually generated, so a higher ceiling on short answers is free.
   */
  maxOutputTokens?: number;
}

/**
 * Build the providers whose keys are present. Absent keys are silently skipped;
 * the returned list is in config default order and may be empty.
 */
export function createProvidersFromEnv(
  env: LlmProviderEnv,
  options: LlmProviderOptions = {},
): LlmProvider[] {
  const shared =
    options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {};
  const providers: LlmProvider[] = [];
  if (env.ANTHROPIC_API_KEY) {
    providers.push(
      createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, ...shared }),
    );
  }
  if (env.OPENAI_API_KEY) {
    providers.push(
      createOpenAiProvider({ apiKey: env.OPENAI_API_KEY, ...shared }),
    );
  }
  if (env.GOOGLE_API_KEY) {
    providers.push(
      createGoogleProvider({ apiKey: env.GOOGLE_API_KEY, ...shared }),
    );
  }
  if (env.GROQ_API_KEY) {
    providers.push(createGroqProvider({ apiKey: env.GROQ_API_KEY, ...shared }));
  }
  return providers;
}
