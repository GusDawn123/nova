import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMockProvider } from "./testing/mock-provider.js";
import { DONE, drain, makeRouter, REQ, tok } from "./testing/router-harness.js";

/**
 * [race] Provider order = config.defaultOrder filtered to supplied providers.
 * A provider that yields no first token within `ttftTimeoutMs` is silently
 * aborted and the router moves to the next provider; the consumer sees only the
 * winner's tokens, no error. All timing is fake-timer driven.
 */
describe("router [race] — time-to-first-token failover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[race] aborts a silent provider after ttftTimeoutMs and yields the next", async () => {
    const a = makeMockProvider("anthropic", { neverYield: true });
    const b = makeMockProvider("openai", {
      events: [tok("Hel"), tok("lo"), DONE],
    });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
      ttftTimeoutMs: 1000,
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(1000);
    const { events, error } = await drained;

    expect(error).toBeUndefined();
    expect(events).toEqual([tok("Hel"), tok("lo"), DONE]);
    expect(a.calls[0]?.aborted).toBe(true);
    expect(b.calls).toHaveLength(1);
  });

  it("[race] keeps a provider that first-tokens within the window, never calling the next", async () => {
    const a = makeMockProvider("anthropic", {
      firstTokenDelayMs: 500,
      events: [tok("ok"), DONE],
    });
    const b = makeMockProvider("openai", { events: [tok("nope"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
      ttftTimeoutMs: 1000,
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(1000);
    const { events, error } = await drained;

    expect(error).toBeUndefined();
    expect(events).toEqual([tok("ok"), DONE]);
    expect(a.calls[0]?.aborted).toBe(false);
    expect(b.calls).toHaveLength(0);
  });

  it("[race] tries providers in config order filtered to those supplied", async () => {
    // google leads the configured order but is not supplied → skipped;
    // anthropic must be tried before openai regardless of the array order below.
    const openai = makeMockProvider("openai", { events: [tok("B"), DONE] });
    const anthropic = makeMockProvider("anthropic", { neverYield: true });
    const router = makeRouter([openai, anthropic], {
      defaultOrder: ["google", "anthropic", "openai", "groq"],
      ttftTimeoutMs: 1000,
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(1000);
    const { events, error } = await drained;

    expect(error).toBeUndefined();
    expect(events).toEqual([tok("B"), DONE]);
    // anthropic was raced first and timed out; openai then won.
    expect(anthropic.calls[0]?.aborted).toBe(true);
    expect(openai.calls).toHaveLength(1);
    expect(openai.calls[0]?.aborted).toBe(false);
  });
});
