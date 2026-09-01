import { describe, expect, it } from "vitest";

import { doneEvent, parseVendorUsage } from "./usage.js";

describe("adapters/usage", () => {
  it("keeps valid nonnegative-integer counts", () => {
    expect(
      parseVendorUsage({
        inputTokens: 5,
        outputTokens: 7,
        cachedInputTokens: 4,
      }),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cachedInputTokens: 4,
    });
  });

  it("drops a malformed count independently of the others", () => {
    expect(parseVendorUsage({ inputTokens: -1, outputTokens: 3 })).toEqual({
      outputTokens: 3,
    });
    expect(parseVendorUsage({ inputTokens: 4, outputTokens: 1.5 })).toEqual({
      inputTokens: 4,
    });
    expect(parseVendorUsage({ inputTokens: "9", outputTokens: null })).toEqual(
      {},
    );
    // The cache count is hostile vendor output like the rest.
    expect(parseVendorUsage({ inputTokens: 4, cachedInputTokens: -2 })).toEqual(
      { inputTokens: 4 },
    );
  });

  it("omits absent fields", () => {
    expect(parseVendorUsage({})).toEqual({});
  });

  it("doneEvent carries counts when present", () => {
    expect(doneEvent({ inputTokens: 2, outputTokens: 4 })).toEqual({
      type: "done",
      usage: { inputTokens: 2, outputTokens: 4 },
    });
  });

  it("doneEvent uses null usage when no counts were parsed", () => {
    expect(doneEvent({})).toEqual({ type: "done", usage: null });
  });
});
