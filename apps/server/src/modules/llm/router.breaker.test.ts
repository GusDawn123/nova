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

  it("[breaker] becomes eligible after breakerCooldownMs and a success resets the count", async () => {
    const a = makeMockProvider("anthropic", [
      { failBeforeFirstToken: { kind: "transient" } },
      { failBeforeFirstToken: { kind: "transient" } },
      { events: [tok("A"), DONE] },
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

    // The success reset the consecutive count: next request tries anthropic first
    // again (it keeps repeating its last, succeeding, script) without re-opening.
    const next = await drain(router.stream(REQ));
    expect(next.events).toEqual([tok("A"), DONE]);
    expect(a.calls).toHaveLength(4);
  });
});
