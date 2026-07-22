import { describe, expect, it, vi } from "vitest";

import type { Meter, UsageEntry } from "./ports.js";
import { makeMockProvider } from "./testing/mock-provider.js";
import {
  doneWith,
  drain,
  makeRouter,
  REQ,
  tok,
} from "./testing/router-harness.js";
import { withMeter } from "./router.js";

/**
 * [meter-opt] Phase 6 per-call meter injection (adr-0007 §2): `stream(req, opts)`
 * accepts an optional `opts.meter` that OVERRIDES the router's constructed default
 * for that one call — user attribution travels WITH THE CALL while breaker/bench
 * state stays process-global. Exactly-once-at-`done` semantics unchanged. The
 * constructed default still meters calls that carry no per-call meter.
 */

function spyMeter(): { meter: Meter; recordUsage: ReturnType<typeof vi.fn> } {
  const recordUsage = vi.fn<(entry: UsageEntry) => void>();
  return { meter: { recordUsage }, recordUsage };
}

const EVENTS = [tok("hi"), doneWith({ inputTokens: 11, outputTokens: 7 })];

describe("router [meter-opt] — per-call meter override", () => {
  it("[meter-opt] a per-call meter wins over the constructed default", async () => {
    const constructed = spyMeter();
    const perCall = spyMeter();
    const a = makeMockProvider("openai", { events: EVENTS });
    const router = makeRouter(
      [a],
      { defaultOrder: ["openai"] },
      constructed.meter,
    );

    const { error } = await drain(
      router.stream(REQ, { meter: perCall.meter }),
    );

    expect(error).toBeUndefined();
    expect(perCall.recordUsage).toHaveBeenCalledTimes(1);
    expect(perCall.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        inputTokens: 11,
        outputTokens: 7,
      }),
    );
    expect(constructed.recordUsage).not.toHaveBeenCalled();
  });

  it("[meter-opt] absent per-call meter falls back to the constructed default", async () => {
    const constructed = spyMeter();
    const a = makeMockProvider("openai", { events: EVENTS });
    const router = makeRouter(
      [a],
      { defaultOrder: ["openai"] },
      constructed.meter,
    );

    const { error } = await drain(router.stream(REQ));

    expect(error).toBeUndefined();
    expect(constructed.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("[meter-opt] per-call metering stays exactly-once when the consumer bails after done", async () => {
    const perCall = spyMeter();
    const a = makeMockProvider("openai", { events: EVENTS });
    const router = makeRouter([a], { defaultOrder: ["openai"] });

    // Consume up to and including `done`, then break — the early-exit unwind path.
    for await (const event of router.stream(REQ, { meter: perCall.meter })) {
      if (event.type === "done") break;
    }

    expect(perCall.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("[meter-opt] the per-call meter is scoped to ITS call only", async () => {
    const constructed = spyMeter();
    const perCall = spyMeter();
    const a = makeMockProvider("openai", { events: EVENTS });
    const router = makeRouter(
      [a],
      { defaultOrder: ["openai"] },
      constructed.meter,
    );

    await drain(router.stream(REQ, { meter: perCall.meter }));
    await drain(router.stream(REQ)); // no per-call meter → default

    expect(perCall.recordUsage).toHaveBeenCalledTimes(1);
    expect(constructed.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("[meter-opt] withMeter() stamps a meter onto every stream call it wraps", async () => {
    const perCall = spyMeter();
    const a = makeMockProvider("openai", { events: EVENTS });
    const router = makeRouter([a], { defaultOrder: ["openai"] });

    const wrapped = withMeter(router, perCall.meter);
    await drain(wrapped.stream(REQ));

    expect(perCall.recordUsage).toHaveBeenCalledTimes(1);
    expect(perCall.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
  });

  it("[meter-opt] withMeter() preserves an explicit opts.signal", async () => {
    const perCall = spyMeter();
    const a = makeMockProvider("openai", { events: EVENTS });
    const router = makeRouter([a], { defaultOrder: ["openai"] });

    const controller = new AbortController();
    controller.abort();
    const wrapped = withMeter(router, perCall.meter);
    const { error } = await drain(
      wrapped.stream(REQ, { signal: controller.signal }),
    );

    // An already-aborted signal must still short-circuit through the wrapper.
    expect(error).toBeInstanceOf(Error);
    expect(perCall.recordUsage).not.toHaveBeenCalled();
  });
});
