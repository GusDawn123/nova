import { describe, expect, it } from "vitest";

import { doneEvent, parseVendorUsage } from "./usage.js";

describe("adapters/usage", () => {
  it("keeps valid nonnegative-integer counts", () => {
    expect(parseVendorUsage({ inputTokens: 5, outputTokens: 7 })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it("drops a malformed count independently of the other", () => {
    expect(parseVendorUsage({ inputTokens: -1, outputTokens: 3 })).toEqual({
      outputTokens: 3,
    });
    expect(parseVendorUsage({ inputTokens: 4, outputTokens: 1.5 })).toEqual({
      inputTokens: 4,
    });
    expect(parseVendorUsage({ inputTokens: "9", outputTokens: null })).toEqual(
      {},
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
