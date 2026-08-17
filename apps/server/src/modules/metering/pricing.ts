import { z } from "zod";

import type { MeteringLogger, UsageEventInput } from "./ports.js";

/**
 * The config-driven price book (adr-0007 §1). Cost estimates are ADVISORY — never
 * blocking: an unknown model/vendor prices to 0 and logs ONE warn per call, so a
 * missing price can never take down a metered call path. Amounts (tokens/seconds/
 * requests) are the source of truth; dollars are order-of-magnitude for the daily
 * kill-switch (adr-0007 §5).
 *
 * Defaults are the plan's book VERBATIM. All zod-`.default()`ed and override-able:
 *   - llm: $/1M input + $/1M output, per model
 *   - stt: $/audio-hour, per vendor
 *   - embedding: $/1M tokens, per model
 *   - rerank: $/1k requests (single rate)
 * Anthropic stays priced though the vendor is disabled (2026-07-22 cost decision) so
 * re-enabling is a key-paste, not a code change.
 */

/** Per-model llm rate: dollars per 1M input tokens + per 1M output tokens. */
const llmRateSchema = z
  .object({
    inputPer1MUsd: z.number().nonnegative(),
    outputPer1MUsd: z.number().nonnegative(),
  })
  .strict();

export const priceBookSchema = z
  .object({
    llm: z.record(z.string(), llmRateSchema).default({
      // 2026-08-17 model refresh (adr-0004 addendum; Gustavo's pick: smarter
      // models, reasoning low). Rates verified at swap time:
      // gemini-3.7-flash $0.75/$3.75 per 1M (intro pricing through 2026-12-31
      // — REVISIT: standard $1.50/$7.50 applies 2027-01-01), gpt-5.6-terra
      // $2/$12 per 1M. Old model ids are DROPPED — costs stamp at write time,
      // so historical usage_events keep the price they were written with;
      // only NEW calls need current rates.
      "gpt-5.6-terra": { inputPer1MUsd: 2.0, outputPer1MUsd: 12.0 },
      "gemini-3.7-flash": { inputPer1MUsd: 0.75, outputPer1MUsd: 3.75 },
      "llama-3.1-8b-instant": { inputPer1MUsd: 0.05, outputPer1MUsd: 0.08 },
      // Kept priced though Anthropic is disabled (adr-0007 §1).
      "claude-haiku-4-5": { inputPer1MUsd: 1.0, outputPer1MUsd: 5.0 },
    }),
    /** $/audio-hour per STT vendor. */
    sttPerHourUsd: z
      .record(z.string(), z.number().nonnegative())
      .default({ assemblyai: 0.15, deepgram: 0.26 }),
    /** $/1M tokens per embedding model (Voyage). */
    embeddingPer1MUsd: z
      .record(z.string(), z.number().nonnegative())
      .default({ "voyage-4": 0.06, "voyage-4-lite": 0.02 }),
    /** $/1k rerank requests (single rate). */
    rerankPer1kRequestsUsd: z.number().nonnegative().default(0.05),
  })
  .strict()
  .default({});

export type PriceBook = z.infer<typeof priceBookSchema>;

/** Prices one usage event to a USD estimate (advisory; unknown → 0 + one warn). */
export interface Pricer {
  price(input: UsageEventInput, logger: MeteringLogger): number;
}

const PER_MILLION = 1_000_000;
const SECONDS_PER_HOUR = 3_600;
const PER_THOUSAND = 1_000;

/**
 * Build a {@link Pricer} over a price book (defaults to the plan's book). Each
 * `price()` call emits AT MOST ONE warn (the unknown-price signal) and never throws.
 */
export function createPricer(
  book: PriceBook = priceBookSchema.parse({}),
): Pricer {
  return {
    price(input: UsageEventInput, logger: MeteringLogger): number {
      switch (input.kind) {
        case "llm_tokens": {
          const rate = input.model ? book.llm[input.model] : undefined;
          if (!rate) return unpriced(input, logger);
          const inputTokens = input.inputAmount ?? 0;
          const outputTokens = input.outputAmount ?? 0;
          return (
            (inputTokens / PER_MILLION) * rate.inputPer1MUsd +
            (outputTokens / PER_MILLION) * rate.outputPer1MUsd
          );
        }
        case "stt_seconds": {
          const perHour = book.sttPerHourUsd[input.vendor];
          if (perHour === undefined) return unpriced(input, logger);
          return (input.amount / SECONDS_PER_HOUR) * perHour;
        }
        case "embedding_tokens": {
          const per1M = input.model
            ? book.embeddingPer1MUsd[input.model]
            : undefined;
          if (per1M === undefined) return unpriced(input, logger);
          return (input.amount / PER_MILLION) * per1M;
        }
        case "rerank_requests": {
          // Single flat rate — always priceable, no unknown case.
          return (input.amount / PER_THOUSAND) * book.rerankPer1kRequestsUsd;
        }
        default: {
          // Exhaustiveness guard (RULES §10): a new kind breaks the build here.
          const never: never = input.kind;
          throw new Error(`unhandled usage kind: ${String(never)}`);
        }
      }
    },
  };
}

/** No price in the book → advisory 0 + one warn (ids/model/vendor only, no content). */
function unpriced(input: UsageEventInput, logger: MeteringLogger): number {
  logger.warn(
    {
      user_id: input.userId,
      kind: input.kind,
      vendor: input.vendor,
      model: input.model ?? null,
    },
    "metering.price_unknown: no price in book, cost estimated as 0",
  );
  return 0;
}
