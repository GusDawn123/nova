import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMockProvider } from "./testing/mock-provider.js";
import {
  asAllProvidersFailed,
  asLlmError,
  DONE,
  drain,
  makeRouter,
  REQ,
  tok,
} from "./testing/router-harness.js";

/**
 * [stall] After commit, a gap between events exceeding `stallTimeoutMs` makes
 * the iterator throw a `stall` LlmError and aborts the underlying attempt.
 * Pre-commit silence is [race]'s concern, not stall's.
 */
describe("router [stall] — post-commit silence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[stall] throws a stall LlmError and aborts when the post-commit gap exceeds stallTimeoutMs", async () => {
    const a = makeMockProvider("anthropic", {
      events: [tok("hi"), tok("later"), DONE],
      interTokenDelayMs: 10_000,
    });
    const b = makeMockProvider("openai", { events: [tok("nope"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
      stallTimeoutMs: 5000,
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(0); // yield & commit on "hi"
    await vi.advanceTimersByTimeAsync(5000); // stall fires before the 10s gap
    const { events, error } = await drained;

    expect(events).toEqual([tok("hi")]);
    expect(asLlmError(error).kind).toBe("stall");
    expect(a.calls[0]?.aborted).toBe(true);
    // Committed: no failover to the next provider on a stall.
    expect(b.calls).toHaveLength(0);
  });

  it("[stall] does not fire before commit — a slow first token is a race timeout, not a stall", async () => {
    const a = makeMockProvider("anthropic", { neverYield: true });
    const router = makeRouter([a], {
      defaultOrder: ["anthropic"],
      ttftTimeoutMs: 1000,
      stallTimeoutMs: 5000,
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(6000);
    const { error } = await drained;

    // Pre-commit exhaustion is terminal failure, never a `stall` kind.
    const failed = asAllProvidersFailed(error);
    expect(failed.kind).toBe("all-providers-failed");
    expect(a.calls[0]?.aborted).toBe(true);
  });
});
