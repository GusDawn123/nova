import { describe, expect, it } from "vitest";

import { meteringConfig, meteringConfigSchema } from "./config.js";

/**
 * Metering config unit tests: the plan's limits/caps are the zod defaults VERBATIM
 * (adr-0007 §4/§5), override-able, and `.strict()` rejects unknown keys.
 */

describe("meteringConfig defaults (the plan's book)", () => {
  it("parses an empty object into the full default set", () => {
    const cfg = meteringConfigSchema.parse({});
    expect(cfg.plans.free).toEqual({
      sttSecondsPerPeriod: 1_800,
      llmTokensPerPeriod: 200_000,
    });
    expect(cfg.plans.pro).toEqual({
      sttSecondsPerPeriod: 36_000,
      llmTokensPerPeriod: 5_000_000,
    });
    expect(cfg.periodDays).toBe(30);
    expect(cfg.dailyGlobalCapUsd).toBe(50);
    expect(cfg.quotaRecheckSeconds).toBe(15);
  });

  it("exposes the parsed defaults as the process-wide singleton", () => {
    expect(meteringConfig).toEqual(meteringConfigSchema.parse({}));
  });

  it("honours overrides", () => {
    const cfg = meteringConfigSchema.parse({
      dailyGlobalCapUsd: 10,
      plans: { pro: { sttSecondsPerPeriod: 1, llmTokensPerPeriod: 2 } },
    });
    expect(cfg.dailyGlobalCapUsd).toBe(10);
    expect(cfg.plans.pro.sttSecondsPerPeriod).toBe(1);
    // Unspecified branches still default.
    expect(cfg.plans.free.sttSecondsPerPeriod).toBe(1_800);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(() =>
      meteringConfigSchema.parse({ bogus: true }),
    ).toThrow();
  });
});
