import { describe, expect, it, vi } from "vitest";

import { createPricer, priceBookSchema } from "./pricing.js";
import type { MeteringLogger, UsageEventInput } from "./ports.js";

/**
 * Pricing unit tests (adr-0007 §1): known models price per the plan's book; an
 * unknown model/vendor prices to 0 and logs EXACTLY ONE warn per call (advisory,
 * never blocks). The book is zod-defaulted + override-able.
 */

function spyLogger(): MeteringLogger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const base = {
  userId: "u1",
  vendor: "openai",
} as const;

describe("createPricer — known models price per the book", () => {
  const pricer = createPricer();

  it("prices an llm call by the input/output split", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      ...base,
      kind: "llm_tokens",
      model: "gpt-4o-mini",
      amount: 1500,
      inputAmount: 1000,
      outputAmount: 500,
    };
    // 1000/1e6 * 0.15 + 500/1e6 * 0.60 = 0.00015 + 0.00030 = 0.00045
    expect(pricer.price(input, logger)).toBeCloseTo(0.00045, 10);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("prices stt_seconds by the vendor $/hour rate", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "assemblyai",
      kind: "stt_seconds",
      amount: 3600, // exactly one hour
    };
    expect(pricer.price(input, logger)).toBeCloseTo(0.15, 10);

    const deepgram: UsageEventInput = { ...input, vendor: "deepgram" };
    expect(pricer.price(deepgram, logger)).toBeCloseTo(0.26, 10);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("prices embedding_tokens by the model $/1M rate", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "voyage",
      kind: "embedding_tokens",
      model: "voyage-4",
      amount: 1_000_000,
    };
    expect(pricer.price(input, logger)).toBeCloseTo(0.06, 10);

    const lite: UsageEventInput = { ...input, model: "voyage-4-lite" };
    expect(pricer.price(lite, logger)).toBeCloseTo(0.02, 10);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("prices rerank_requests by the flat $/1k rate (no unknown case)", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "voyage",
      kind: "rerank_requests",
      amount: 2000,
    };
    // 2000/1000 * 0.05 = 0.10
    expect(pricer.price(input, logger)).toBeCloseTo(0.1, 10);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps Anthropic priced though the vendor is disabled", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "anthropic",
      kind: "llm_tokens",
      model: "claude-haiku-4-5",
      amount: 2_000_000,
      inputAmount: 1_000_000,
      outputAmount: 1_000_000,
    };
    // 1M/1e6 * 1.00 + 1M/1e6 * 5.00 = 6.00
    expect(pricer.price(input, logger)).toBeCloseTo(6.0, 10);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("createPricer — unknown price → 0 + exactly one warn", () => {
  const pricer = createPricer();

  it("unknown llm model → 0 + one warn", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "openai",
      kind: "llm_tokens",
      model: "gpt-does-not-exist",
      amount: 1000,
      inputAmount: 500,
      outputAmount: 500,
    };
    expect(pricer.price(input, logger)).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("llm with no model at all → 0 + one warn", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "openai",
      kind: "llm_tokens",
      amount: 10,
      inputAmount: 5,
      outputAmount: 5,
    };
    expect(pricer.price(input, logger)).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("unknown stt vendor → 0 + one warn", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "nobody",
      kind: "stt_seconds",
      amount: 600,
    };
    expect(pricer.price(input, logger)).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("unknown embedding model → 0 + one warn", () => {
    const logger = spyLogger();
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "voyage",
      kind: "embedding_tokens",
      model: "voyage-999",
      amount: 5000,
    };
    expect(pricer.price(input, logger)).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("priceBook is zod-defaulted + override-able", () => {
  it("parses an empty object into the full default book", () => {
    const book = priceBookSchema.parse({});
    expect(book.llm["gpt-4o-mini"]).toEqual({
      inputPer1MUsd: 0.15,
      outputPer1MUsd: 0.6,
    });
    expect(book.sttPerHourUsd.deepgram).toBe(0.26);
    expect(book.rerankPer1kRequestsUsd).toBe(0.05);
  });

  it("honours an overridden rate", () => {
    const logger = spyLogger();
    const book = priceBookSchema.parse({
      rerankPer1kRequestsUsd: 0.2,
    });
    const pricer = createPricer(book);
    const input: UsageEventInput = {
      userId: "u1",
      vendor: "voyage",
      kind: "rerank_requests",
      amount: 1000,
    };
    expect(pricer.price(input, logger)).toBeCloseTo(0.2, 10);
  });
});
