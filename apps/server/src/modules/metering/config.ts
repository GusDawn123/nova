import { z } from "zod";

/**
 * `modules/metering` plan limits + spend caps — one zod schema, every knob
 * `.default()`ed and injectable (adr-0007 §4/§5). No `process.env` reads live in this
 * module; env wiring stays in app.ts/env.ts (the RAG/notes precedent). Defaults are
 * the plan's book VERBATIM: free 1 800 stt-seconds + 200k llm-tokens per period; pro
 * 36 000 stt-seconds + 5M llm-tokens; 30-day rolling period; $50/day global cap;
 * 15-second mid-stream quota recheck cadence.
 *
 * Design sources: `docs/DESIGN/metering.md`, `docs/DECISIONS/adr-0007-metering.md`.
 */

/** Per-plan quota limits (amounts, not dollars — adr-0007 §4). */
const planLimitsSchema = z
  .object({
    /** Rolling-period STT budget in relayed-audio seconds. */
    sttSecondsPerPeriod: z.number().int().positive(),
    /** Rolling-period LLM budget in tokens (input + output). */
    llmTokensPerPeriod: z.number().int().positive(),
  })
  .strict();

export const meteringConfigSchema = z
  .object({
    plans: z
      .object({
        free: planLimitsSchema.default({
          sttSecondsPerPeriod: 1_800,
          llmTokensPerPeriod: 200_000,
        }),
        pro: planLimitsSchema.default({
          sttSecondsPerPeriod: 36_000,
          llmTokensPerPeriod: 5_000_000,
        }),
      })
      .strict()
      .default({}),
    /** Rolling quota window length in days (adr-0007 §4). */
    periodDays: z.number().int().positive().default(30),
    /** Global daily spend kill-switch, USD (adr-0007 §5). */
    dailyGlobalCapUsd: z.number().positive().default(50),
    /** Mid-stream quota recheck cadence in seconds of METERED audio (adr-0007 §4). */
    quotaRecheckSeconds: z.number().int().positive().default(15),
    /**
     * RevenueCat product_id → the plan it GRANTS (adr-0007 §7). Purchases of a
     * mapped product upgrade to its plan; its EXPIRATION downgrades to 'free'.
     * Unknown products never error — the webhook answers {applied:false} + warn.
     */
    revenuecatProducts: z
      .record(z.string(), z.enum(["free", "pro"]))
      .default({ nova_pro_monthly: "pro" }),
  })
  .strict()
  .default({});

export type MeteringConfig = z.infer<typeof meteringConfigSchema>;

/** Plan identifiers (matches profiles.plan CHECK). */
export type PlanId = keyof MeteringConfig["plans"];

/** The process-wide defaults (parse of an empty object — every field is defaulted). */
export const meteringConfig: MeteringConfig = meteringConfigSchema.parse({});

/**
 * Live running notes are a PAID feature (Phase 8, docs/DESIGN/live-notes.md §8).
 * Co-located with the plan limits above because it is the same kind of decision:
 * what a plan buys.
 *
 * Unlike the quota checks it is a capability, not a budget — so it is a plain
 * predicate over the plan, resolved once per session and latched (a mid-call
 * downgrade does not kill a call already in progress).
 *
 * MAPPING: `pro` only. That is the conservative reading of design-doc §12.2,
 * which is still an OPEN QUESTION for Gustavo (pro-only, or its own tier?) — a
 * fold costs roughly $0.10–0.15 per hour-long call, so it does not belong on the
 * free plan either way. Changing the answer is this one line.
 */
export function canUseLiveNotes(plan: PlanId): boolean {
  return plan === "pro";
}
