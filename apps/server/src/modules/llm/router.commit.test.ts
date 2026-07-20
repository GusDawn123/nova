import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMockProvider } from "./testing/mock-provider.js";
import {
  asLlmError,
  DONE,
  drain,
  makeRouter,
  REQ,
  tok,
} from "./testing/router-harness.js";

/**
 * [commit] The first NON-EMPTY `token` commits the router to a provider.
 * (a) Empty-string tokens do not commit. (b) After commit the router never
 * switches: a committed provider that then throws surfaces its typed error to
 * the consumer after the already-yielded tokens — no other provider is tried.
 *
 * [abort] Caller `opts.signal` abort mid-stream → the iterator throws an
 * `aborted` LlmError promptly and the underlying attempt is aborted.
 */
describe("router [commit] — first non-empty token commits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[commit] never switches after commit: a committed provider's throw surfaces, no failover", async () => {
    const a = makeMockProvider("anthropic", {
      events: [tok("Hel"), tok("lo"), DONE],
      failAfterTokens: 2,
    });
    const b = makeMockProvider("openai", { events: [tok("SHOULD-NOT"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(0);
    const { events, error } = await drained;

    expect(events).toEqual([tok("Hel"), tok("lo")]);
    expect(asLlmError(error).kind).toBe("transient");
    // Committed: the second provider is never called.
    expect(b.calls).toHaveLength(0);
  });

  it("[commit] an empty-string token does not commit: '' then a pre-commit death fails over", async () => {
    const a = makeMockProvider("anthropic", {
      events: [tok(""), DONE],
      failAfterTokens: 1,
    });
    const b = makeMockProvider("openai", { events: [tok("real"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(0);
    const { events, error } = await drained;

    expect(error).toBeUndefined();
    // The uncommitted empty token is discarded; consumer sees only the winner.
    expect(events).toEqual([tok("real"), DONE]);
    expect(b.calls).toHaveLength(1);
  });

  it("[commit] does not hang after a committed provider dies (no phantom failover events)", async () => {
    const a = makeMockProvider("anthropic", {
      events: [tok("one"), DONE],
      failAfterTokens: 1,
    });
    const b = makeMockProvider("openai", { events: [tok("two"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
    });

    const drained = drain(router.stream(REQ));
    // Advancing well past any timeout must not conjure a failover.
    await vi.advanceTimersByTimeAsync(1_000_000);
    const { events, error } = await drained;

    expect(events).toEqual([tok("one")]);
    expect(asLlmError(error).kind).toBe("transient");
    expect(b.calls).toHaveLength(0);
  });
});

describe("router [abort] — caller cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[abort] mid-stream signal abort throws an aborted LlmError and aborts the attempt", async () => {
    const a = makeMockProvider("anthropic", {
      events: [tok("one"), tok("two"), DONE],
      interTokenDelayMs: 1000,
    });
    const router = makeRouter([a], { defaultOrder: ["anthropic"] });
    const controller = new AbortController();

    const drained = drain(router.stream(REQ, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0); // commit on "one", then await the gap
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const { events, error } = await drained;

    expect(events).toEqual([tok("one")]);
    expect(asLlmError(error).kind).toBe("aborted");
    expect(a.calls[0]?.aborted).toBe(true);
  });

  it("[abort] an already-aborted signal throws aborted without yielding", async () => {
    const a = makeMockProvider("anthropic", { events: [tok("x"), DONE] });
    const router = makeRouter([a], { defaultOrder: ["anthropic"] });
    const controller = new AbortController();
    controller.abort();

    const { events, error } = await drain(
      router.stream(REQ, { signal: controller.signal }),
    );

    expect(events).toHaveLength(0);
    expect(asLlmError(error).kind).toBe("aborted");
  });
});
