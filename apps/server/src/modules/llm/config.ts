import { z } from "zod";

import { providerIdSchema } from "./ports.js";

/**
 * Every knob the router behaves by, all tunable and all defaulted, so a test (or
 * a later env-wiring phase) can override any single value and rely on the rest.
 * This schema deliberately reads NO `process.env` — config is passed in; env
 * wiring lands in a later phase.
 */
export const llmConfigSchema = z.object({
  /** How long to wait for the FIRST token before failing a provider over. */
  ttftTimeoutMs: z.number().int().positive().default(2500),
  /** Max silence on an already-committed stream before it's a `stall`. */
  stallTimeoutMs: z.number().int().positive().default(20000),
  /** Consecutive failures that trip a provider's circuit breaker open. */
  breakerThreshold: z.number().int().positive().default(5),
  /** How long a tripped breaker stays open before a trial request. */
  breakerCooldownMs: z.number().int().positive().default(30000),
  /**
   * How long an `auth` failure benches a provider — far longer than a transient
   * cooldown, because a bad key won't fix itself in 30s (10 min default).
   */
  authCooldownMs: z.number().int().positive().default(600000),
  /**
   * Default failover order when a request doesn't override `providerOrder` and
   * carries no live latency tier — the DELIBERATE (quality-first) order (adr-0004
   * §4/§5): notes pipeline, follow-up.
   */
  defaultOrder: z
    .array(providerIdSchema)
    .min(1)
    .default(["anthropic", "openai", "google", "groq"]),
  /**
   * The LIVE cascade order (adr-0004 §5), chosen automatically for a request
   * whose `latencyTier` is `"live"` and which does not override
   * `providerOrder`. Since 2026-08-19 this is the OWNER'S PICK, no longer
   * strictly cheapest-first: GPT is the default live model and Gemini the
   * fallback (Gustavo, 2026-08-19), then Groq Llama, then Anthropic. Model
   * policy is config, not code: swaps never touch the router.
   */
  liveOrder: z
    .array(providerIdSchema)
    .min(1)
    .default(["openai", "google", "groq", "anthropic"]),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

/**
 * A latency-first router config (adr-0004 §4): the LIVE tier's TTFT/stall
 * budgets, over `liveOrder` (openai-first since 2026-08-19 — the owner's pick).
 * The live copilot conductor builds its router from this so a slow first
 * provider is abandoned fast enough to keep the question-moment → first-token
 * gate (p50 < 2s). Reasoning/thinking is OFF at the ADAPTER layer for every
 * live-cascade model (the OpenAI mini pins effort "none", the lite Gemini omits
 * thinkingConfig, 8b has none), so there is no per-call reasoning toggle here.
 */
export function liveLlmConfig(
  overrides: Partial<z.input<typeof llmConfigSchema>> = {},
): LlmConfig {
  return llmConfigSchema.parse({
    // Per-provider first-token window. 1500ms served the non-thinking lite
    // era, but during the 2026-08-17 thinking-model refresh it aborted a
    // HEALTHY primary on every ask (live repro: all providers "aborted"). The
    // 2026-08-19 revert put non-thinking models back, yet 5s is KEPT
    // DELIBERATELY: it only slows the failure path, never a healthy answer,
    // and a truly dead vendor still fails over well inside the conductor's
    // 12s overall deadline.
    ttftTimeoutMs: 5000,
    // The stall window matches the schema default: since M2 (Brain A + no
    // output caps), live answers include long commented code, and vendors
    // legitimately gap >8s mid-generation on those — an 8s window truncated a
    // real answer mid-code (2026-08-17 live repro). TTFT above still guards
    // the fast-failover moment; this only governs an already-committed stream.
    stallTimeoutMs: 20000,
    ...overrides,
  });
}
