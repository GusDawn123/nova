import { describe, expect, it } from "vitest";

import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("applies defaults when no env vars are set", () => {
    const result = parseEnv({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        NODE_ENV: "development",
        PORT: 3000,
        HOST: "127.0.0.1",
      });
    }
  });

  it("coerces a numeric PORT string into a number", () => {
    const result = parseEnv({ PORT: "8080" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(8080);
    }
  });

  it("fails when PORT is not a number", () => {
    const result = parseEnv({ PORT: "abc" });

    expect(result.success).toBe(false);
  });
});
