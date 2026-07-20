import { describe, expect, it } from "vitest";

import { normalizedTokenOverlap, normalizeTokens } from "./text-metrics.js";

describe("normalizeTokens", () => {
  it("lowercases, strips punctuation, and splits on whitespace", () => {
    expect(normalizeTokens("Hello, World!  It's here.")).toEqual([
      "hello",
      "world",
      "it",
      "s",
      "here",
    ]);
  });

  it("returns no tokens for empty / punctuation-only input", () => {
    expect(normalizeTokens("   ")).toEqual([]);
    expect(normalizeTokens("!!! ...")).toEqual([]);
  });
});

describe("normalizedTokenOverlap", () => {
  it("scores a perfect match as 1", () => {
    expect(normalizedTokenOverlap("the quick brown fox", "the quick brown fox")).toBe(1);
  });

  it("is punctuation- and case-insensitive", () => {
    expect(normalizedTokenOverlap("Hello there.", "hello, THERE")).toBe(1);
  });

  it("scores partial recall as the fraction of reference tokens found", () => {
    // 3 of 4 reference tokens appear in the hypothesis.
    expect(normalizedTokenOverlap("one two three four", "one two three")).toBeCloseTo(
      0.75,
    );
  });

  it("does not reward extra hypothesis tokens (recall, not precision)", () => {
    expect(
      normalizedTokenOverlap("call me back", "please call me back tomorrow okay"),
    ).toBe(1);
  });

  it("is multiset-aware: a word needed twice must appear twice", () => {
    expect(normalizedTokenOverlap("no no no", "no")).toBeCloseTo(1 / 3);
    expect(normalizedTokenOverlap("no no no", "no no no")).toBe(1);
  });

  it("handles empty edges", () => {
    expect(normalizedTokenOverlap("", "")).toBe(1);
    expect(normalizedTokenOverlap("", "anything")).toBe(0);
    expect(normalizedTokenOverlap("something", "")).toBe(0);
  });
});
