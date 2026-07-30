import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerLiveEvent } from "@nova/shared";

import { liveLlmConfig } from "../llm/index.js";
import { makeMockProvider } from "../llm/testing/mock-provider.js";
import { DONE, makeRouter, tok } from "../llm/testing/router-harness.js";

import { conductorConfigSchema } from "./conductor-config.js";
import { createLiveConductor } from "./conductor.js";

/**
 * [latency] The tested latency contract (design: live-pipeline.md §"Latency is a
 * tested contract"). Realistic mock-LLM TTFT delays fed through the REAL llm
 * router + REAL conductor under fake timers; the benchmark PRINTS p50/p95 and
 * asserts the bars:
 *   - playbook gate:   question moment → first token   p50 < 2000ms, p95 < 4000ms
 *   - design bar:      final utterance → visible        p50 < 1500ms
 *   - design bar:      speculation hit → visible        p50 < 500ms
 * "Visible" is always the FIRST token, never the full response.
 */

/** Deterministic realistic TTFT samples (ms) for a cheap live model. */
const NONSPEC_TTFT = [300, 450, 600, 700, 800, 900, 1000, 1100, 1300, 1450];
/** Faster samples for the speculation path (fires before the utterance ends). */
const SPEC_TTFT = [150, 200, 250, 300, 350, 400, 450, 500, 550, 600];
/** Time between a confident partial and its final (the "speech tail"). */
const SPEECH_TAIL_MS = 900;

let events: { type: string; t: number }[];

function capture(): (e: ServerLiveEvent) => void {
  return (e) => events.push({ type: e.type, t: Date.now() });
}

function routerWith(firstTokenDelayMs: number) {
  const provider = makeMockProvider("google", {
    firstTokenDelayMs,
    interTokenDelayMs: 15,
    events: [tok("Direct"), tok(" answer"), tok(" here"), DONE],
  });
  return makeRouter([provider], liveLlmConfig());
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? 0;
}

function firstDeltaTime(t0: number): number | null {
  const delta = events.find((e) => e.type === "suggestion.delta");
  return delta ? delta.t - t0 : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("modules/live [latency] tested contract", () => {
  it("[latency] question moment → first token: p50<2s, p95<4s (final→visible p50<1.5s)", async () => {
    const latencies: number[] = [];
    for (const ttft of NONSPEC_TTFT) {
      events = [];
      const conductor = createLiveConductor({
        send: capture(),
        router: routerWith(ttft),
        config: conductorConfigSchema.parse({ speculationEnabled: false }),
      });
      const t0 = Date.now();
      conductor.onFinal("What is your pricing model exactly?", "them");
      await vi.advanceTimersByTimeAsync(ttft + 500);
      const latency = firstDeltaTime(t0);
      expect(latency).not.toBeNull();
      if (latency !== null) latencies.push(latency);
      conductor.dispose();
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    console.log(
      `[latency] question→first-token: p50=${String(p50)}ms p95=${String(p95)}ms (n=${String(latencies.length)}) bars p50<2000 p95<4000; design final→visible p50<1500`,
    );
    expect(p50).toBeLessThan(2000);
    expect(p95).toBeLessThan(4000);
    expect(p50).toBeLessThan(1500); // the tighter design bar too
  });

  it("[latency] speculation hit → visible: p50<500ms", async () => {
    const visibles: number[] = [];
    for (const ttft of SPEC_TTFT) {
      events = [];
      const conductor = createLiveConductor({
        send: capture(),
        router: routerWith(ttft),
        config: conductorConfigSchema.parse({ speculationEnabled: true }),
      });
      const t0 = Date.now();
      // Fire on the confident partial, let it stream during the speech tail…
      conductor.onPartial(
        "what's your approach to handling data consistency",
        "them",
      );
      await vi.advanceTimersByTimeAsync(SPEECH_TAIL_MS);
      // …then the final lands. On a hit the answer is already visible.
      conductor.onFinal(
        "what's your approach to handling data consistency?",
        "them",
      );
      await vi.advanceTimersByTimeAsync(200);
      const firstDelta = firstDeltaTime(t0);
      expect(firstDelta).not.toBeNull();
      // Visible latency measured from the FINAL utterance moment (the user's clock).
      const finalMoment = SPEECH_TAIL_MS;
      const visible =
        firstDelta !== null ? Math.max(0, firstDelta - finalMoment) : 0;
      visibles.push(visible);
      conductor.dispose();
    }

    const p50 = percentile(visibles, 50);
    const p95 = percentile(visibles, 95);
    console.log(
      `[latency] speculation-hit→visible: p50=${String(p50)}ms p95=${String(p95)}ms (n=${String(visibles.length)}) bar p50<500`,
    );
    expect(p50).toBeLessThan(500);
  });
});
