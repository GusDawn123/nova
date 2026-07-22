import { describe, expect, it } from "vitest";

import {
  AllProvidersFailedError,
  classifyHttpStatus,
  isLlmError,
  LlmError,
  type ProviderFailure,
} from "./errors.js";

describe("classifyHttpStatus", () => {
  it("maps 401 and 403 to auth", () => {
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("auth");
  });

  it("maps every other status to transient", () => {
    // Phase 6: 400 moved to the `invalid` class (router.invalid.test.ts covers
    // 400/404/422); the remaining statuses keep their transient semantics.
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyHttpStatus(status)).toBe("transient");
    }
  });
});

describe("LlmError factories", () => {
  it("build a subclass of Error carrying the right kind", () => {
    const e = LlmError.auth();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.name).toBe("LlmError");
    expect(e.kind).toBe("auth");
    expect(isLlmError(e)).toBe(true);
  });

  it.each([
    ["auth", LlmError.auth()],
    ["transient", LlmError.transient()],
    ["stall", LlmError.stall()],
    ["aborted", LlmError.aborted()],
  ] as const)("sets kind %s", (kind, error) => {
    expect(error.kind).toBe(kind);
  });

  it("threads a custom message and cause", () => {
    const cause = new Error("root");
    const e = LlmError.transient("boom", { cause });
    expect(e.message).toBe("boom");
    expect(e.cause).toBe(cause);
  });

  it("classifies via fromHttpStatus", () => {
    expect(LlmError.fromHttpStatus(403, "x").kind).toBe("auth");
    expect(LlmError.fromHttpStatus(503, "x").kind).toBe("transient");
  });
});

describe("AllProvidersFailedError", () => {
  it("carries the per-provider failure summary", () => {
    const failures: readonly ProviderFailure[] = [
      { provider: "anthropic", kind: "auth", message: "bad key" },
      { provider: "openai", kind: "transient", message: "503" },
    ];
    const e = LlmError.allProvidersFailed(failures);
    expect(e).toBeInstanceOf(AllProvidersFailedError);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.name).toBe("AllProvidersFailedError");
    expect(e.kind).toBe("all-providers-failed");
    expect(e.failures).toEqual(failures);
    expect(isLlmError(e)).toBe(true);
  });
});

describe("isLlmError", () => {
  it("rejects plain errors and non-errors", () => {
    expect(isLlmError(new Error("nope"))).toBe(false);
    expect(isLlmError("nope")).toBe(false);
    expect(isLlmError(null)).toBe(false);
  });
});
