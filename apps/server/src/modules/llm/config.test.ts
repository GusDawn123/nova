import { describe, expect, it } from "vitest";

import { llmConfigSchema } from "./config.js";

describe("llmConfigSchema", () => {
  it("applies every default from an empty object", () => {
    expect(llmConfigSchema.parse({})).toEqual({
      ttftTimeoutMs: 2500,
      stallTimeoutMs: 20000,
      breakerThreshold: 5,
      breakerCooldownMs: 30000,
      authCooldownMs: 600000,
      defaultOrder: ["anthropic", "openai", "google", "groq"],
      liveOrder: ["openai", "google", "groq", "anthropic"],
    });
  });

  it("accepts overrides while defaulting the rest", () => {
    const cfg = llmConfigSchema.parse({
      ttftTimeoutMs: 1000,
      defaultOrder: ["groq"],
    });
    expect(cfg.ttftTimeoutMs).toBe(1000);
    expect(cfg.defaultOrder).toEqual(["groq"]);
    expect(cfg.stallTimeoutMs).toBe(20000);
    expect(cfg.authCooldownMs).toBe(600000);
  });

  it("rejects non-positive timeouts", () => {
    expect(llmConfigSchema.safeParse({ ttftTimeoutMs: 0 }).success).toBe(false);
    expect(llmConfigSchema.safeParse({ stallTimeoutMs: -1 }).success).toBe(
      false,
    );
  });

  it("rejects non-integer tunables", () => {
    expect(llmConfigSchema.safeParse({ breakerThreshold: 1.5 }).success).toBe(
      false,
    );
  });

  it("rejects an empty order and unknown provider ids", () => {
    expect(llmConfigSchema.safeParse({ defaultOrder: [] }).success).toBe(false);
    expect(
      llmConfigSchema.safeParse({ defaultOrder: ["mistral"] }).success,
    ).toBe(false);
  });
});
