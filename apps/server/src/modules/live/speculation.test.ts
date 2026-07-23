import { describe, expect, it } from "vitest";

import {
  isConfidentPartial,
  jaccardSimilarity,
  reconcile,
} from "./speculation.js";

describe("modules/live [speculation] jaccard + reconcile", () => {
  it("[speculation] identical texts score 1, disjoint score 0", () => {
    expect(jaccardSimilarity("what is databricks", "what is databricks")).toBe(1);
    expect(jaccardSimilarity("alpha beta", "gamma delta")).toBe(0);
    expect(jaccardSimilarity("", "")).toBe(1);
  });

  it("[speculation] a near-final partial reconciles as adopt", () => {
    const partial = "what's your approach to handling data";
    const final = "what's your approach to handling data consistency?";
    expect(reconcile(partial, final, 0.6)).toBe("adopt");
  });

  it("[speculation] a diverged final reconciles as discard", () => {
    const partial = "what's your approach to";
    const final = "actually never mind, let's talk about pricing tiers instead";
    expect(reconcile(partial, final, 0.6)).toBe("discard");
  });

  it("[speculation] confidence needs a question mark or enough words", () => {
    expect(isConfidentPartial("what is", 6)).toBe(false);
    expect(isConfidentPartial("what is databricks?", 6)).toBe(true);
    expect(
      isConfidentPartial("so how did you scale the ingestion pipeline", 6),
    ).toBe(true);
  });
});
