import { describe, expect, it, vi } from "vitest";

import { LlmError } from "../errors.js";
import type { ChatRequest, LlmStreamEvent } from "../ports.js";
import { makeMockProvider, type SleepFn } from "./mock-provider.js";

const REQ: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

const tok = (text: string): LlmStreamEvent => ({ type: "token", text });
const DONE: LlmStreamEvent = { type: "done", usage: null };

/** Drain an async iterable, capturing a thrown error rather than propagating. */
async function drain(
  iterable: AsyncIterable<LlmStreamEvent>,
): Promise<{ events: LlmStreamEvent[]; error: unknown }> {
  const events: LlmStreamEvent[] = [];
  try {
    for await (const event of iterable) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

/** Await a promise, returning its rejection value (or undefined if it resolves). */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectLlmError(value: unknown): asserts value is LlmError {
  expect(value).toBeInstanceOf(LlmError);
  if (!(value instanceof LlmError)) {
    throw new Error("expected an LlmError");
  }
}

describe("makeMockProvider — happy path", () => {
  it("yields scripted events in order and records tokens", async () => {
    const provider = makeMockProvider("anthropic", {
      events: [
        tok("Hel"),
        tok("lo"),
        { type: "done", usage: { outputTokens: 2 } },
      ],
    });

    const { events, error } = await drain(
      provider.stream(REQ, new AbortController().signal),
    );

    expect(error).toBeUndefined();
    expect(events).toEqual([
      tok("Hel"),
      tok("lo"),
      { type: "done", usage: { outputTokens: 2 } },
    ]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request).toBe(REQ);
    expect(provider.calls[0]?.tokensYielded).toBe(2);
    expect(provider.calls[0]?.aborted).toBe(false);
  });
});

describe("makeMockProvider — failure modes", () => {
  it("throws a typed auth error before the first token", async () => {
    const provider = makeMockProvider("openai", {
      failBeforeFirstToken: { kind: "auth" },
    });

    const { events, error } = await drain(
      provider.stream(REQ, new AbortController().signal),
    );

    expect(events).toHaveLength(0);
    expectLlmError(error);
    expect(error.kind).toBe("auth");
  });

  it("throws a typed transient error before the first token", async () => {
    const provider = makeMockProvider("openai", {
      failBeforeFirstToken: { kind: "transient" },
    });

    const { error } = await drain(
      provider.stream(REQ, new AbortController().signal),
    );

    expectLlmError(error);
    expect(error.kind).toBe("transient");
  });

  it("emits n tokens then dies mid-stream", async () => {
    const provider = makeMockProvider("google", {
      events: [tok("a"), tok("b"), tok("c"), DONE],
      failAfterTokens: 2,
    });

    const { events, error } = await drain(
      provider.stream(REQ, new AbortController().signal),
    );

    expect(events).toEqual([tok("a"), tok("b")]);
    expectLlmError(error);
    expect(error.kind).toBe("transient");
    expect(provider.calls[0]?.tokensYielded).toBe(2);
  });

  it("can die mid-stream with a stall kind", async () => {
    const provider = makeMockProvider("groq", {
      events: [tok("a"), tok("b")],
      failAfterTokens: 1,
      failAfterKind: "stall",
    });

    const { events, error } = await drain(
      provider.stream(REQ, new AbortController().signal),
    );

    expect(events).toEqual([tok("a")]);
    expectLlmError(error);
    expect(error.kind).toBe("stall");
  });
});

describe("makeMockProvider — abort handling", () => {
  it("hangs on neverYield until aborted, recording the abort", async () => {
    const provider = makeMockProvider("anthropic", { neverYield: true });
    const controller = new AbortController();
    const iterator = provider
      .stream(REQ, controller.signal)
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.abort();
    const error = await captureError(pending);

    expectLlmError(error);
    expect(error.kind).toBe("aborted");
    expect(provider.calls[0]?.aborted).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const provider = makeMockProvider("openai", { events: [tok("a"), DONE] });
    const controller = new AbortController();
    controller.abort();

    const { events, error } = await drain(
      provider.stream(REQ, controller.signal),
    );

    expect(events).toHaveLength(0);
    expectLlmError(error);
    expect(error.kind).toBe("aborted");
    expect(provider.calls[0]?.aborted).toBe(true);
  });
});

describe("makeMockProvider — fake-timer driven delays", () => {
  it("delays the first token by firstTokenDelayMs with no real waiting", async () => {
    vi.useFakeTimers();
    try {
      const provider = makeMockProvider("openai", {
        firstTokenDelayMs: 2500,
        events: [tok("hi"), DONE],
      });
      const iterator = provider
        .stream(REQ, new AbortController().signal)
        [Symbol.asyncIterator]();

      const first = iterator.next();
      let settled = false;
      void first.then(
        () => (settled = true),
        () => (settled = true),
      );

      await vi.advanceTimersByTimeAsync(2499);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await first;
      expect(settled).toBe(true);
      expect(result.done).toBe(false);
      expect(result.value).toEqual(tok("hi"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("spaces successive tokens by interTokenDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const provider = makeMockProvider("google", {
        events: [tok("a"), tok("b"), DONE],
        interTokenDelayMs: 1000,
      });
      const iterator = provider
        .stream(REQ, new AbortController().signal)
        [Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.value).toEqual(tok("a"));

      const second = iterator.next();
      let settled = false;
      void second.then(
        () => (settled = true),
        () => (settled = true),
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await second;
      expect(result.value).toEqual(tok("b"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a pending TTFT delay under fake timers", async () => {
    vi.useFakeTimers();
    try {
      const provider = makeMockProvider("groq", {
        firstTokenDelayMs: 5000,
        events: [tok("a"), DONE],
      });
      const controller = new AbortController();
      const iterator = provider
        .stream(REQ, controller.signal)
        [Symbol.asyncIterator]();

      const captured = captureError(iterator.next());
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort();
      const error = await captured;

      expectLlmError(error);
      expect(error.kind).toBe("aborted");
      expect(provider.calls[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("makeMockProvider — scripting and DI", () => {
  it("consumes one script per call, repeating the last", async () => {
    const provider = makeMockProvider("anthropic", [
      { failBeforeFirstToken: { kind: "auth" } },
      { events: [tok("ok"), DONE] },
    ]);

    const first = await drain(
      provider.stream(REQ, new AbortController().signal),
    );
    expect(first.error).toBeInstanceOf(LlmError);

    const second = await drain(
      provider.stream(REQ, new AbortController().signal),
    );
    expect(second.error).toBeUndefined();
    expect(second.events).toEqual([tok("ok"), DONE]);

    // Third call has no script of its own — the last one repeats.
    const third = await drain(
      provider.stream(REQ, new AbortController().signal),
    );
    expect(third.error).toBeUndefined();
    expect(third.events).toEqual([tok("ok"), DONE]);
    expect(provider.calls).toHaveLength(3);
  });

  it("routes every delay through an injected sleep", async () => {
    const observed: number[] = [];
    const sleep: SleepFn = (ms) => {
      observed.push(ms);
      return Promise.resolve();
    };
    const provider = makeMockProvider(
      "openai",
      {
        firstTokenDelayMs: 42,
        interTokenDelayMs: 7,
        events: [tok("a"), tok("b"), DONE],
      },
      { sleep },
    );

    await drain(provider.stream(REQ, new AbortController().signal));

    // TTFT once, then interToken before each subsequent event (b and done).
    expect(observed).toEqual([42, 7, 7]);
  });

  it("rejects an empty script list", () => {
    expect(() => makeMockProvider("anthropic", [])).toThrow();
  });
});
