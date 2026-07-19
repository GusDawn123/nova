import { describe, expect, it } from "vitest";

import { healthResponseSchema, type HealthResponse } from "./health.js";

describe("healthResponseSchema", () => {
  it("parses a valid health response", () => {
    const parsed: HealthResponse = healthResponseSchema.parse({
      ok: true,
      version: "0.0.0",
    });

    expect(parsed).toEqual({ ok: true, version: "0.0.0" });
  });

  it("rejects a response with a missing version", () => {
    const result = healthResponseSchema.safeParse({ ok: true });

    expect(result.success).toBe(false);
  });

  it("rejects a response with a non-boolean ok", () => {
    const result = healthResponseSchema.safeParse({ ok: "yes", version: "1" });

    expect(result.success).toBe(false);
  });
});
