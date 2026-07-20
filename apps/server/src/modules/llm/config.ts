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
  /** Default failover order when a request doesn't override `providerOrder`. */
  defaultOrder: z
    .array(providerIdSchema)
    .min(1)
    .default(["anthropic", "openai", "google", "groq"]),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;
