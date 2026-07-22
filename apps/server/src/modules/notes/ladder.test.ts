import { describe, expect, it } from "vitest";
import { z } from "zod";

import { makeMockProvider, type ChatMessage } from "../llm/index.js";
import { LlmError } from "../llm/errors.js";
import {
  doneWith,
  makeRouter,
  tok,
} from "../llm/testing/router-harness.js";

import { runLadder } from "./ladder.js";

/**
 * Ladder behaviour vs scripted mock providers (the llm testing harness). No fake
 * timers: the scripts carry no delays, so the router's ttft/stall timers are armed
 * and immediately cleared when each token lands — nothing waits on real wall-clock,
 * and no timer leaks as an unhandled rejection.
 */

const schema = z
  .object({ a: z.number(), b: z.string() })
  .strict();
type Shape = z.infer<typeof schema>;

/** Build a single-provider router that returns each given text on successive calls. */
function routerReturning(...texts: string[]) {
  const scripts = texts.map((text) => ({
    events: [tok(text), doneWith({ inputTokens: 10, outputTokens: 5 })],
  }));
  const provider = makeMockProvider("anthropic", scripts);
  const router = makeRouter([provider], { defaultOrder: ["anthropic"] });
  return { router, provider };
}

/** A repair prompt builder that echoes the invalid output + issues + the law phrase. */
function repairBuilder(invalidText: string, issues: string): ChatMessage[] {
  return [
    {
      role: "user",
      content: `Previous invalid output:\n${invalidText}\n\nProblems:\n${issues}\n\npreserve all valid content, return ONLY the corrected JSON`,
    },
  ];
}

const messages: ChatMessage[] = [{ role: "user", content: "make json" }];

describe("runLadder — clean and salvage rungs", () => {
  it("parses clean JSON on the first call with no salvage or repair", async () => {
    const { router, provider } = routerReturning('{"a":1,"b":"ok"}');
    const out = await runLadder<Shape>({ schema, messages, router, repair: repairBuilder });

    expect(out.result).toEqual({ status: "ok", value: { a: 1, b: "ok" } });
    expect(out.telemetry).toEqual({
      salvageApplied: false,
      repairUsed: false,
      fellBack: false,
    });
    expect(provider.calls).toHaveLength(1);
    expect(out.usage).toEqual([{ inputTokens: 10, outputTokens: 5 }]);
  });

  it("extracts JSON from a ```json fenced block (salvage, no repair)", async () => {
    const { router, provider } = routerReturning(
      'Here you go:\n```json\n{"a":2,"b":"fenced"}\n```\n',
    );
    const out = await runLadder<Shape>({ schema, messages, router, repair: repairBuilder });

    expect(out.result).toEqual({ status: "ok", value: { a: 2, b: "fenced" } });
    expect(out.telemetry.salvageApplied).toBe(true);
    expect(out.telemetry.repairUsed).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it("extracts JSON from prose-wrapped output via the brace scan", async () => {
    const { router } = routerReturning(
      'Sure! {"a":3,"b":"prose"} — hope that helps.',
    );
    const out = await runLadder<Shape>({ schema, messages, router, repair: repairBuilder });

    expect(out.result).toEqual({ status: "ok", value: { a: 3, b: "prose" } });
    expect(out.telemetry.salvageApplied).toBe(true);
  });

  it("repairs a trailing comma with jsonrepair (salvage, no repair call)", async () => {
    const { router, provider } = routerReturning('{"a":4,"b":"trail",}');
    const out = await runLadder<Shape>({ schema, messages, router, repair: repairBuilder });

    expect(out.result).toEqual({ status: "ok", value: { a: 4, b: "trail" } });
    expect(out.telemetry.salvageApplied).toBe(true);
    expect(out.telemetry.repairUsed).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it("repairs single-quoted keys/values with jsonrepair", async () => {
    const { router } = routerReturning("{'a': 5, 'b': 'single'}");
    const out = await runLadder<Shape>({ schema, messages, router, repair: repairBuilder });

    expect(out.result).toEqual({ status: "ok", value: { a: 5, b: "single" } });
    expect(out.telemetry.salvageApplied).toBe(true);
  });
});

describe("runLadder — repair round-trip", () => {
  it("spends EXACTLY ONE repair call carrying the invalid output + issue paths + preserve law", async () => {
    // First response is valid JSON but schema-wrong (a is a string); second is fixed.
    const { router, provider } = routerReturning(
      '{"a":"nope","b":"x"}',
      '{"a":6,"b":"repaired"}',
    );
    const out = await runLadder<Shape>({ schema, messages, router, repair: repairBuilder });

    expect(out.result).toEqual({ status: "ok", value: { a: 6, b: "repaired" } });
    expect(out.telemetry).toEqual({
      salvageApplied: false,
      repairUsed: true,
      fellBack: false,
    });
    // Exactly two router calls total: the generate + one repair.
    expect(provider.calls).toHaveLength(2);
    const repairPrompt = provider.calls[1]?.request.messages[0]?.content ?? "";
    expect(repairPrompt).toContain('{"a":"nope","b":"x"}'); // the invalid output
    expect(repairPrompt).toContain("a:"); // a zod issue path line
    expect(repairPrompt).toContain("return ONLY the corrected JSON"); // the law
    // Two usage entries — one per call.
    expect(out.usage).toHaveLength(2);
  });

  it("falls back after the single repair also fails (no second repair)", async () => {
    const { router, provider } = routerReturning(
      '{"a":"bad","b":"x"}',
      "still not json at all",
    );
    const out = await runLadder<Shape>({ schema, messages, router, repair: repairBuilder });

    expect(out.result).toEqual({ status: "failed" });
    expect(out.telemetry.repairUsed).toBe(true);
    expect(out.telemetry.fellBack).toBe(true);
    expect(provider.calls).toHaveLength(2); // exactly one repair, then stop
    expect(out.rawText).toBe("still not json at all"); // raw surfaced for the job row
  });
});

describe("runLadder — transport errors propagate (content-only fallback)", () => {
  it("lets an LlmError from the router throw instead of falling back", async () => {
    const provider = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "transient" },
    });
    const router = makeRouter([provider], { defaultOrder: ["anthropic"] });

    await expect(
      runLadder<Shape>({ schema, messages, router, repair: repairBuilder }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});
