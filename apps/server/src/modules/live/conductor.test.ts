import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerLiveEvent } from "@nova/shared";

import { liveLlmConfig, type Meter, type UsageEntry } from "../llm/index.js";
import { makeMockProvider } from "../llm/testing/mock-provider.js";
import { makeRouter } from "../llm/testing/router-harness.js";
import { DONE, tok } from "../llm/testing/router-harness.js";

import { conductorConfigSchema } from "./conductor-config.js";
import { createLiveConductor, type LiveConductor } from "./conductor.js";

/**
 * [conductor] The live loop: quiet in small talk, fires on questions, coalesces
 * deltas, speculates + reconciles (adopt/discard, never a zombie), supersedes,
 * and enforces the first-token deadline ladder. Real llm router + scriptable
 * mock provider under fake timers (the Phase 2 suite's style).
 */

let events: ServerLiveEvent[];
let seq = 0;

function capture(): (e: ServerLiveEvent) => void {
  return (e) => events.push(e);
}

function idFactory(): () => string {
  return () => `00000000-0000-0000-0000-${String(seq++).padStart(12, "0")}`;
}

function router(script: {
  firstTokenDelayMs?: number;
  interTokenDelayMs?: number;
  tokens?: string[];
  neverYield?: boolean;
}) {
  const provider = makeMockProvider("google", {
    ...(script.firstTokenDelayMs !== undefined
      ? { firstTokenDelayMs: script.firstTokenDelayMs }
      : {}),
    ...(script.interTokenDelayMs !== undefined
      ? { interTokenDelayMs: script.interTokenDelayMs }
      : {}),
    ...(script.neverYield ? { neverYield: true } : {}),
    events: (script.tokens ?? ["Answer", " here"]).map(tok).concat(DONE),
  });
  return makeRouter([provider], liveLlmConfig());
}

const CONFIG = conductorConfigSchema.parse({
  coalesceMs: 50,
  firstTokenDeadlineMs: 4000,
});

function makeConductor(
  overrides: Partial<Parameters<typeof createLiveConductor>[0]> = {},
): LiveConductor {
  return createLiveConductor({
    send: capture(),
    router: router({ firstTokenDelayMs: 100, interTokenDelayMs: 10 }),
    config: CONFIG,
    generateSuggestionId: idFactory(),
    ...overrides,
  });
}

function types(): string[] {
  return events.map((e) => e.type);
}

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("modules/live [conductor] quiet + fire", () => {
  it("[conductor] stays silent on small-talk finals", async () => {
    const c = makeConductor();
    c.onFinal("Hey, how are you doing today?", "them");
    c.onFinal("Yeah totally, sounds good.", "me");
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toHaveLength(0);
  });

  it("[conductor] fires start→delta→done on a question final", async () => {
    const c = makeConductor();
    c.onFinal("What is your pricing model exactly?", "them");
    await vi.advanceTimersByTimeAsync(1000);
    expect(types()).toContain("suggestion.start");
    expect(types()).toContain("suggestion.delta");
    expect(types()[types().length - 1]).toBe("suggestion.done");
    const done = events.find((e) => e.type === "suggestion.done");
    expect(done && "text" in done ? done.text : "").toBe("Answer here");
  });

  it("[conductor] discards as no_response when a provider emits no token", async () => {
    // Pins the contract that makes the conductor's empty-completion branch
    // unreachable. A provider CAN complete having emitted nothing (a refusal, a
    // safety stop), but the router classifies "stream ended without ever producing
    // a token" as a transient failure (router.ts) and never surfaces it as a clean
    // stream — so the conductor takes its catch path and clears the pane with
    // `no_response` rather than sending `suggestion.done` with empty text.
    //
    // This is regression cover, not a bug fix: a CodeRabbit finding claimed the
    // success path emitted an empty `suggestion.done`. It cannot, because of the
    // router guarantee above. If that guarantee is ever relaxed, this test fails
    // and the conductor genuinely will need its own empty-completion branch.
    const c = makeConductor({
      router: router({ firstTokenDelayMs: 20, tokens: [] }),
    });
    c.onFinal("What is your pricing model exactly?", "them");
    await vi.advanceTimersByTimeAsync(1000);

    const done = events.find((e) => e.type === "suggestion.done");
    expect(done).toBeUndefined();

    const discard = events.find((e) => e.type === "suggestion.discard");
    expect(discard).toBeDefined();
    expect(discard && "reason" in discard ? discard.reason : "").toBe(
      "no_response",
    );
  });

  it("[conductor] coalesces many tokens into fewer deltas (~50ms batches)", async () => {
    const c = makeConductor({
      router: router({
        firstTokenDelayMs: 20,
        interTokenDelayMs: 5, // 10 tokens x 5ms = 50ms total, well under one batch
        tokens: Array.from({ length: 10 }, (_, i) => `t${String(i)}`),
      }),
    });
    c.onFinal("Can you walk me through the architecture?", "them");
    await vi.advanceTimersByTimeAsync(1000);
    const deltas = events.filter((e) => e.type === "suggestion.delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.length).toBeLessThan(10); // batched, not one-per-token
  });
});

describe("modules/live [conductor] speculation reconcile", () => {
  it("[conductor] adopts a speculation whose final matches (no discard)", async () => {
    const c = makeConductor({
      router: router({ firstTokenDelayMs: 50, interTokenDelayMs: 5 }),
    });
    c.onPartial("what's your approach to handling data", "them");
    await vi.advanceTimersByTimeAsync(200);
    expect(types()).toContain("suggestion.start");
    // The final is essentially the same utterance → adopt, keep streaming.
    c.onFinal("what's your approach to handling data consistency?", "them");
    await vi.advanceTimersByTimeAsync(500);
    expect(types().filter((t) => t === "suggestion.discard")).toHaveLength(0);
    expect(types().filter((t) => t === "suggestion.start")).toHaveLength(1);
    expect(types()).toContain("suggestion.done");
  });

  it("[conductor] discards a speculation whose final diverged, then refires", async () => {
    const c = makeConductor({
      router: router({ firstTokenDelayMs: 50, interTokenDelayMs: 5 }),
    });
    c.onPartial("what's your approach to scaling the", "them");
    await vi.advanceTimersByTimeAsync(200);
    expect(types()).toContain("suggestion.start");
    // Diverged final → the speculative card must be discarded, then a fresh one.
    c.onFinal("actually forget that, what is Kubernetes anyway?", "them");
    await vi.advanceTimersByTimeAsync(500);
    expect(types()).toContain("suggestion.discard");
    expect(types().filter((t) => t === "suggestion.start")).toHaveLength(2);
  });
});

describe("modules/live [conductor] supersede + deadline + meter", () => {
  it("[conductor] a new trigger supersedes the in-flight suggestion (discard)", async () => {
    const c = makeConductor({
      config: conductorConfigSchema.parse({
        speculationEnabled: false,
        coalesceMs: 50,
      }),
      router: router({ firstTokenDelayMs: 300, interTokenDelayMs: 50 }),
    });
    c.onFinal("What is your pricing model?", "them");
    await vi.advanceTimersByTimeAsync(50); // start emitted, mid-generation
    c.onFinal("And how does the onboarding process work?", "them");
    await vi.advanceTimersByTimeAsync(1000);
    expect(types()).toContain("suggestion.discard");
    expect(types().filter((t) => t === "suggestion.start")).toHaveLength(2);
  });

  it("[conductor] the deadline ladder discards when no first token arrives", async () => {
    const c = makeConductor({
      config: conductorConfigSchema.parse({
        firstTokenDeadlineMs: 1000,
        coalesceMs: 50,
      }),
      router: router({ neverYield: true }),
    });
    c.onFinal("What is your pricing model exactly?", "them");
    await vi.advanceTimersByTimeAsync(2000);
    const discard = events.find((e) => e.type === "suggestion.discard");
    expect(discard && "reason" in discard ? discard.reason : "").toBe(
      "no_response",
    );
  });

  it("[conductor] threads the per-call meter (usage recorded)", async () => {
    const recorded: UsageEntry[] = [];
    const meter: Meter = { recordUsage: (e) => recorded.push(e) };
    const c = makeConductor({
      meter,
      router: router({ firstTokenDelayMs: 20, interTokenDelayMs: 5 }),
    });
    c.onFinal("What is your pricing model exactly?", "them");
    await vi.advanceTimersByTimeAsync(500);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0]?.provider).toBe("google");
  });

  it("[conductor] dispose aborts an in-flight generation without a done", async () => {
    const c = makeConductor({
      router: router({ firstTokenDelayMs: 300 }),
    });
    c.onFinal("What is your pricing model exactly?", "them");
    await vi.advanceTimersByTimeAsync(50);
    c.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(types()).not.toContain("suggestion.done");
  });
});

describe("modules/live [conductor] onDirectQuestion (Phase 8 typed-input fix)", () => {
  it("[conductor] answers text the trigger gate would veto", async () => {
    const c = makeConductor();
    // A bare statement from the user: `evaluateTrigger` returns no_trigger, so
    // the gated path stays silent. But this was typed straight AT the copilot —
    // you asked it something, so it answers (the 2026-07-23 prompt-freedom
    // decision: "the AI always answers").
    c.onDirectQuestion("the customer seems hesitant");
    await vi.advanceTimersByTimeAsync(500);

    expect(types()).toContain("suggestion.start");
    expect(events.find((e) => e.type === "suggestion.done")).toMatchObject({
      text: "Answer here",
    });
  });

  it("[conductor] stays silent on the SAME text through the gated path", async () => {
    const c = makeConductor();
    c.onFinal("the customer seems hesitant", "me");
    await vi.advanceTimersByTimeAsync(500);
    // Proves the previous test is exercising the bypass, not a lenient gate.
    expect(events).toHaveLength(0);
  });

  it("[conductor] never emits a transcript event for a direct question", async () => {
    const c = makeConductor();
    c.onDirectQuestion("what did we quote Acme?");
    await vi.advanceTimersByTimeAsync(500);
    // The conductor speaks only in suggestion.* — nothing it emits can be
    // mistaken for an utterance by the other party.
    expect(types().every((t) => !t.startsWith("transcript."))).toBe(true);
  });
});
