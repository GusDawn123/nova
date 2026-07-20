import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMockProvider } from "./testing/mock-provider.js";
import { DONE, drain, makeRouter, REQ, tok } from "./testing/router-harness.js";

/**
 * [breaker] `breakerThreshold` CONSECUTIVE pre-commit failures of a provider
 * (counted across requests) open its circuit: for `breakerCooldownMs` the router
 * skips it WITHOUT calling it. After cooldown it is eligible again; one success
 * resets the consecutive-failure count.
 */
describe("router [breaker] — consecutive pre-commit failure circuit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[breaker] opens after breakerThreshold consecutive failures and then skips without calling", async () => {
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "transient" },
    });
    const b = makeMockProvider("openai", { events: [tok("b"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
      breakerThreshold: 2,
    });

    // Request 1 & 2: anthropic fails pre-commit, openai wins. Two real calls.
    for (let i = 0; i < 2; i += 1) {
      const { events, error } = await drain(router.stream(REQ));
      expect(error).toBeUndefined();
      expect(events).toEqual([tok("b"), DONE]);
    }
    expect(a.calls).toHaveLength(2);

    // Request 3: breaker is open → anthropic is skipped WITHOUT being called.
    const { events, error } = await drain(router.stream(REQ));
    expect(error).toBeUndefined();
    expect(events).toEqual([tok("b"), DONE]);
    expect(a.calls).toHaveLength(2); // zero new calls while open
  });

  it("[breaker] becomes eligible after breakerCooldownMs and a success resets the count (full threshold required to re-open)", async () => {
    const a = makeMockProvider("anthropic", [
      { failBeforeFirstToken: { kind: "transient" } }, // 1 → consecutive 1
      { failBeforeFirstToken: { kind: "transient" } }, // 2 → consecutive 2, opens
      { events: [tok("A"), DONE] }, //                    3 trial success → reset
      { failBeforeFirstToken: { kind: "transient" } }, // 4 fresh fail #1 (not enough)
      { failBeforeFirstToken: { kind: "transient" } }, // 5 fresh fail #2 → re-opens
    ]);
    const b = makeMockProvider("openai", { events: [tok("b"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
      breakerThreshold: 2,
      breakerCooldownMs: 10_000,
    });

    // Two failures open the breaker; request 3 skips anthropic entirely.
    await drain(router.stream(REQ));
    await drain(router.stream(REQ));
    await drain(router.stream(REQ));
    expect(a.calls).toHaveLength(2);

    // After cooldown, anthropic is eligible again and now succeeds (script[2]).
    await vi.advanceTimersByTimeAsync(10_000);
    const trial = await drain(router.stream(REQ));
    expect(trial.error).toBeUndefined();
    expect(trial.events).toEqual([tok("A"), DONE]);
    expect(a.calls).toHaveLength(3);

    // STRENGTHENED: the success reset the consecutive count to zero, so a SINGLE
    // fresh failure must NOT re-open the circuit — the FULL breakerThreshold of
    // consecutive failures is required again.
    await drain(router.stream(REQ)); // fresh fail #1 (script[3]) → consecutive 1
    expect(a.calls).toHaveLength(4); // still eligible: it was actually called
    await drain(router.stream(REQ)); // fresh fail #2 (script[4]) → consecutive 2, re-opens
    expect(a.calls).toHaveLength(5);

    // Only now (full threshold reached again) is the breaker open → skipped.
    await drain(router.stream(REQ));
    expect(a.calls).toHaveLength(5); // zero new calls while re-opened
  });
});
