import { describe, expect, it } from "vitest";

import { computeBackoff, notesConfig, notesConfigSchema } from "./config.js";

describe("notesConfig", () => {
  it("pins every tunable to its designed default", () => {
    expect(notesConfig).toEqual({
      pollIntervalMs: 5_000,
      leaseMs: 600_000,
      reaperIntervalMs: 30_000,
      maxAttempts: 5,
      backoffBaseMs: 60_000,
      backoffFactor: 3,
      backoffCapMs: 900_000,
      sweepBatchSize: 10,
      staleCallMaxAgeMs: 21_600_000,
      staleReaperIntervalMs: 60_000,
      maxSinglePassTokens: 32_000,
      mapChunkTokens: 6_000,
      mapOverlapRatio: 0.15,
      classifyHeadTokens: 2_000,
    });
  });

  it("is fully defaulted — parse({}) yields the process-wide config", () => {
    expect(notesConfigSchema.parse({})).toEqual(notesConfig);
  });

  it("rejects an unknown key (.strict)", () => {
    expect(() => notesConfigSchema.parse({ nope: 1 })).toThrow();
  });

  it("accepts injected overrides for tests (tiny intervals)", () => {
    const cfg = notesConfigSchema.parse({ leaseMs: 5, pollIntervalMs: 1 });
    expect(cfg.leaseMs).toBe(5);
    expect(cfg.pollIntervalMs).toBe(1);
    expect(cfg.maxAttempts).toBe(5); // untouched default
  });
});

describe("computeBackoff", () => {
  // rand()=0.5 → the ±10% jitter term is exactly zero, so the base curve shows.
  const noJitter = (): number => 0.5;

  it("is 60s · 3^(attempts−1) on the base curve", () => {
    expect(computeBackoff(1, notesConfig, noJitter)).toBe(60_000);
    expect(computeBackoff(2, notesConfig, noJitter)).toBe(180_000);
    expect(computeBackoff(3, notesConfig, noJitter)).toBe(540_000);
  });

  it("caps at 15 minutes", () => {
    // attempt 4 → 60s·27 = 1,620,000 > cap; attempt 10 stays capped.
    expect(computeBackoff(4, notesConfig, noJitter)).toBe(900_000);
    expect(computeBackoff(10, notesConfig, noJitter)).toBe(900_000);
  });

  it("applies ±10% jitter via the injected rand", () => {
    expect(computeBackoff(1, notesConfig, () => 0)).toBe(54_000); // −10%
    expect(computeBackoff(1, notesConfig, () => 1)).toBe(66_000); // +10%
  });

  it("treats attempt 0/1 as the first step (never a negative exponent)", () => {
    expect(computeBackoff(0, notesConfig, noJitter)).toBe(60_000);
  });
});
