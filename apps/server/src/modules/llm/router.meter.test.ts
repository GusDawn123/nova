import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmStreamEvent, Meter, UsageEntry } from "./ports.js";
import { makeMockProvider } from "./testing/mock-provider.js";
import {
  asAllProvidersFailed,
  doneWith,
  drain,
  makeRouter,
  REQ,
  tok,
} from "./testing/router-harness.js";

/**
 * [meter] On successful completion (a `done` event), `meter.recordUsage` is
 * called exactly once with the WINNING provider's id and the done event's usage.
 * On a stream that ends in total pre-commit failure it is not called at all.
 */
describe("router [meter] — usage accounting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[meter] records usage exactly once with the winner's id and the done usage", async () => {
    const recordUsage = vi.fn<(entry: UsageEntry) => void>();
    const meter: Meter = { recordUsage };
    const a = makeMockProvider("anthropic", {
      events: [tok("hi"), doneWith({ inputTokens: 5, outputTokens: 7 })],
    });
    const router = makeRouter([a], { defaultOrder: ["anthropic"] }, meter);

    const { error } = await drain(router.stream(REQ));

    expect(error).toBeUndefined();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        inputTokens: 5,
        outputTokens: 7,
      }),
    );
  });

  it("[meter] attributes usage to the failover WINNER, not a failed provider", async () => {
    const recordUsage = vi.fn<(entry: UsageEntry) => void>();
    const meter: Meter = { recordUsage };
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "transient" },
    });
    const b = makeMockProvider("openai", {
      events: [tok("ok"), doneWith({ outputTokens: 3 })],
    });
    const router = makeRouter(
      [a, b],
      { defaultOrder: ["anthropic", "openai"] },
      meter,
    );

    const { error } = await drain(router.stream(REQ));

    expect(error).toBeUndefined();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", outputTokens: 3 }),
    );
  });

  it("[meter] does not record usage when every provider fails pre-commit", async () => {
    const recordUsage = vi.fn<(entry: UsageEntry) => void>();
    const meter: Meter = { recordUsage };
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "transient" },
    });
    const b = makeMockProvider("openai", {
      failBeforeFirstToken: { kind: "auth" },
    });
    const router = makeRouter(
      [a, b],
      { defaultOrder: ["anthropic", "openai"], ttftTimeoutMs: 1000 },
      meter,
    );

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(2000);
    const { error } = await drained;

    asAllProvidersFailed(error);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("[meter] still records usage when the consumer stops right after the done event", async () => {
    const recordUsage = vi.fn<(entry: UsageEntry) => void>();
    const meter: Meter = { recordUsage };
    const a = makeMockProvider("anthropic", {
      events: [tok("hi"), doneWith({ inputTokens: 2, outputTokens: 4 })],
    });
    const router = makeRouter([a], { defaultOrder: ["anthropic"] }, meter);

    // Consumer bails the moment it sees `done` — the generator is unwound at
    // that yield, so any accounting placed AFTER the attempt would never run.
    const events: LlmStreamEvent[] = [];
    for await (const event of router.stream(REQ)) {
      events.push(event);
      if (event.type === "done") {
        break;
      }
    }

    expect(events).toEqual([
      tok("hi"),
      doneWith({ inputTokens: 2, outputTokens: 4 }),
    ]);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        inputTokens: 2,
        outputTokens: 4,
      }),
    );
  });

  it("[meter] does not record usage when the consumer bails mid-stream before done", async () => {
    const recordUsage = vi.fn<(entry: UsageEntry) => void>();
    const meter: Meter = { recordUsage };
    const a = makeMockProvider("anthropic", {
      events: [tok("one"), tok("two"), doneWith({ outputTokens: 9 })],
    });
    const router = makeRouter([a], { defaultOrder: ["anthropic"] }, meter);

    const events: LlmStreamEvent[] = [];
    for await (const event of router.stream(REQ)) {
      events.push(event);
      break; // give up after the first token, before any done
    }

    expect(events).toEqual([tok("one")]);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
