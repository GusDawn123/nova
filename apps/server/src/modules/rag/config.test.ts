import { describe, expect, it } from "vitest";

import { ragConfig } from "./config.js";

describe("ragConfig", () => {
  it("pins every tunable to its designed value", () => {
    expect(ragConfig).toEqual({
      targetChunkTokens: 400,
      maxChunkTokens: 512,
      docOverlapRatio: 0.15,
      maxChunksPerSource: 2000,
      candidatesPerLeg: 30,
      rrfK: 50,
      kLive: 8,
      kDeliberate: 12,
      defaultTokenBudgetTokens: 1500,
      queryEmbedTimeoutMs: 2500,
      ingestEmbedTimeoutMs: 30000,
      sweepIntervalMs: 20000,
      sweepBatchSize: 5,
      embedBatchSize: 64,
    });
  });

  it("keeps the soft target below the hard cap", () => {
    expect(ragConfig.targetChunkTokens).toBeLessThan(ragConfig.maxChunkTokens);
  });

  it("keeps the live k below the deliberate k", () => {
    expect(ragConfig.kLive).toBeLessThan(ragConfig.kDeliberate);
  });
});
