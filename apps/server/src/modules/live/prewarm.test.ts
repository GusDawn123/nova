import { describe, expect, it, vi } from "vitest";

import type {
  ChatRequest,
  LlmRouter,
  LlmStreamEvent,
  Meter,
} from "../llm/index.js";
import { assembleMeeting } from "../prompt/index.js";

import { PREWARM_USER_MESSAGE, prewarmPromptCache } from "./prewarm.js";

/**
 * [prewarm] The session-start cache warm (Natively reference §4/§6): one tiny
 * live-tier request whose system message is Brain A's BYTE-IDENTICAL
 * stablePrefix (the cache keys on the prefix), threaded through the per-call
 * meter, and contractually fire-and-forget — a router failure logs and
 * resolves, never rejects into the session-start path.
 */

interface CapturedCall {
  req: ChatRequest;
  opts?: { signal?: AbortSignal; meter?: Meter };
}

function makeRouter(events: LlmStreamEvent[] | Error): {
  router: LlmRouter;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const router: LlmRouter = {
    // eslint-disable-next-line @typescript-eslint/require-await -- the mock yields scripted events synchronously; `async *` is the port's shape, not a promise the test waits on
    async *stream(req, opts) {
      calls.push({ req, ...(opts !== undefined ? { opts } : {}) });
      if (events instanceof Error) throw events;
      yield* events;
    },
  };
  return { router, calls };
}

const DONE: LlmStreamEvent = {
  type: "done",
  usage: { inputTokens: 5000, outputTokens: 2, cachedInputTokens: 4800 },
};

describe("live/prewarm", () => {
  it("sends ONE live-tier request carrying Brain A's byte-stable prefix + the meter", async () => {
    const { router, calls } = makeRouter([{ type: "token", text: "ok" }, DONE]);
    const meter: Meter = { recordUsage: vi.fn() };

    await prewarmPromptCache({ router, meter });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.req.latencyTier).toBe("live");
    // Byte-identical to what real asks send — anything else warms a DIFFERENT
    // cache entry and the warm is pure spend.
    expect(call?.req.messages[0]).toEqual({
      role: "system",
      content: assembleMeeting({ transcript: [] }).stablePrefix,
    });
    expect(call?.req.messages[1]).toEqual({
      role: "user",
      content: PREWARM_USER_MESSAGE,
    });
    // The warm is billed like every other vendor call (adr-0007).
    expect(call?.opts?.meter).toBe(meter);
    expect(call?.opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("logs the warm's usage (cache telemetry included) on completion", async () => {
    const { router } = makeRouter([{ type: "token", text: "ok" }, DONE]);
    const info = vi.fn();
    const error = vi.fn();

    await prewarmPromptCache({
      router,
      logger: { info, error },
      userId: "user-1",
      meetingId: "meeting-1",
    });

    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      user_id: "user-1",
      meeting_id: "meeting-1",
      input_tokens: 5000,
      cached_input_tokens: 4800,
    });
    expect(info.mock.calls[0]?.[1]).toBe("live.prewarm_done");
  });

  it("NEVER rejects: a router failure logs and resolves (best-effort contract)", async () => {
    const { router } = makeRouter(new Error("all providers failed"));
    const error = vi.fn();

    await expect(
      prewarmPromptCache({ router, logger: { error } }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBe("live.prewarm_failed");
  });

  it("warms the OVERRIDE prefix when one is passed (the composer era)", async () => {
    // When PROMPT_COMPOSER_ENABLED is on, real asks send the composed prefix -
    // warming the legacy one would write the wrong cache entry, so the wiring
    // hands the active prefix in and the warm must use it byte-for-byte.
    const { router, calls } = makeRouter([{ type: "token", text: "ok" }, DONE]);

    await prewarmPromptCache({ router, stablePrefix: "COMPOSED PREFIX" });

    expect(calls[0]?.req.messages[0]).toEqual({
      role: "system",
      content: "COMPOSED PREFIX",
    });
  });
});
