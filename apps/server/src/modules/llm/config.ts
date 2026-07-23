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
   * The LIVE (latency-first) cascade order (adr-0004 §5): cheapest/fastest first
   * — Gemini Flash (thinking off) → Groq Llama → OpenAI mini → Anthropic. Chosen
   * automatically for a request whose `latencyTier` is `"live"` and which does
   * not override `providerOrder`. Model policy is config, not code: swaps never
   * touch the router.
   */
  liveOrder: z
    .array(providerIdSchema)
    .min(1)
    .default(["google", "groq", "openai", "anthropic"]),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

/**
 * A latency-first router config (adr-0004 §4): the LIVE tier's tight TTFT/stall
 * budgets, over the cheapest-first `liveOrder`. The live copilot conductor builds
 * its router from this so a slow first provider is abandoned fast enough to keep
 * the question-moment → first-token gate (p50 < 2s). Reasoning/thinking is OFF at
 * the ADAPTER layer for every live-cascade model (flash `thinkingBudget: 0`,
 * mini/8b have none), so there is no per-call reasoning toggle to thread here.
 */
export function liveLlmConfig(
  overrides: Partial<z.input<typeof llmConfigSchema>> = {},
): LlmConfig {
  return llmConfigSchema.parse({
    // Move off a stalled first provider quickly — the cascade's whole point on
    // the live path. Still generous enough not to abandon a warming vendor.
    ttftTimeoutMs: 1500,
    // A live suggestion is short; a committed stream going quiet for 8s is dead.
    stallTimeoutMs: 8000,
    ...overrides,
  });
}
