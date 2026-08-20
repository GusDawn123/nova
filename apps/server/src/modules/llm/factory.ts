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
   * Output-token ceiling for every provider built here. OMITTED in production
   * — no product cap on answer length (Gustavo, 2026-08-17: a 1024 cap
   * silently squeezed the mandated comments out of code answers); adapters
   * send no ceiling unless one is configured (Anthropic's vendor-required
   * `max_tokens` field aside). The seam stays for tests/smoke tools that
   * WANT tiny outputs.
   */
  maxOutputTokens?: number;
  /**
   * Sampling temperature applied to every provider built here. The live
   * wiring passes 0.3 (Natively reference, 2026-08-18 doc: answer paths at
   * 0.25–0.4 — "lower = faster, more focused"); omitted elsewhere so the
   * deliberate tier keeps each vendor's own default.
   */
  temperature?: number;
}

/**
 * Build the providers whose keys are present. Absent keys are silently skipped;
 * the returned list is in config default order and may be empty.
 */
export function createProvidersFromEnv(
  env: LlmProviderEnv,
  options: LlmProviderOptions = {},
): LlmProvider[] {
  const shared = {
    ...(options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
  };
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
