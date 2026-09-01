import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveLlmConfig } from "./config.js";
import { makeMockProvider } from "./testing/mock-provider.js";
import { DONE, drain, makeRouter, REQ, tok } from "./testing/router-harness.js";

/**
 * [tier] The `latencyTier` extension (adr-0004 §4): a `"live"` request routes
 * the `liveOrder` cascade (openai-first since the 2026-08-19 revert — the
 * owner's pick); a deliberate/absent request keeps the quality-first
 * `defaultOrder`; an explicit `providerOrder` still wins over the tier.
 * Reasoning-off is an ADAPTER concern, so there is nothing tier-specific to
 * assert here beyond order selection.
 */
describe("router [tier] — latency-tier order selection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('[tier] latencyTier "live" uses liveOrder, not defaultOrder', async () => {
    const google = makeMockProvider("google", { events: [tok("G"), DONE] });
    const anthropic = makeMockProvider("anthropic", {
      events: [tok("A"), DONE],
    });
    const router = makeRouter([anthropic, google], {
      defaultOrder: ["anthropic", "google"],
      liveOrder: ["google", "anthropic"],
    });

    const live = await drain(router.stream({ ...REQ, latencyTier: "live" }));
    expect(live.events).toEqual([tok("G"), DONE]);
    expect(google.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(0); // liveOrder put google first
  });

  it("[tier] deliberate/absent keeps defaultOrder", async () => {
    const google = makeMockProvider("google", { events: [tok("G"), DONE] });
    const anthropic = makeMockProvider("anthropic", {
      events: [tok("A"), DONE],
    });
    const router = makeRouter([anthropic, google], {
      defaultOrder: ["anthropic", "google"],
      liveOrder: ["google", "anthropic"],
    });

    const deliberate = await drain(router.stream(REQ));
    expect(deliberate.events).toEqual([tok("A"), DONE]);
    expect(anthropic.calls).toHaveLength(1);
  });

  it("[tier] an explicit providerOrder overrides the live tier", async () => {
    const google = makeMockProvider("google", { events: [tok("G"), DONE] });
    const openai = makeMockProvider("openai", { events: [tok("O"), DONE] });
    const router = makeRouter([google, openai], {
      liveOrder: ["google", "openai"],
    });

    const overridden = await drain(
      router.stream({
        ...REQ,
        latencyTier: "live",
        providerOrder: ["openai", "google"],
      }),
    );
    expect(overridden.events).toEqual([tok("O"), DONE]);
    expect(openai.calls).toHaveLength(1);
    expect(google.calls).toHaveLength(0);
  });

  it("[tier] liveLlmConfig keeps the 5s TTFT window and the openai-first default liveOrder", () => {
    const config = liveLlmConfig();
    expect(config.ttftTimeoutMs).toBe(5000);
    // Post-M2: long commented-code answers gap >8s mid-stream legitimately, so
    // the live stall window matches the schema default (only TTFT stays tight).
    expect(config.stallTimeoutMs).toBe(20000);
    // Owner's pick (Gustavo, 2026-08-19): GPT is the default live model and
    // Gemini the fallback — no longer strictly cheapest-first.
    expect(config.liveOrder).toEqual(["openai", "google", "groq", "anthropic"]);
  });
});
