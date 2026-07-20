import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMockProvider } from "./testing/mock-provider.js";
import {
  DONE,
  drain,
  makeConfig,
  makeRouter,
  REQ,
  tok,
} from "./testing/router-harness.js";

/**
 * [classify] ONE `auth`-kind failure benches a provider immediately for
 * `authCooldownMs` — no threshold. Transient failures only count toward
 * [breaker]. auth benches FAR longer than a transient blip: `authCooldownMs`
 * default ≫ `breakerCooldownMs` (asserted from config, not hardcoded).
 */
describe("router [classify] — auth benches, transient only counts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[classify] a single auth failure benches the provider far longer than a breaker cooldown", async () => {
    const config = makeConfig({ defaultOrder: ["anthropic", "openai"] });
    // The law under test: auth benches far longer than a transient breaker blip.
    expect(config.authCooldownMs).toBeGreaterThan(config.breakerCooldownMs);

    const a = makeMockProvider("anthropic", [
      { failBeforeFirstToken: { kind: "auth" } },
      { events: [tok("A"), DONE] },
    ]);
    const b = makeMockProvider("openai", { events: [tok("b"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
    });

    // Request 1: anthropic auth-fails once → benched immediately. openai wins.
    await drain(router.stream(REQ));
    expect(a.calls).toHaveLength(1);

    // Request 2 (no time passed): anthropic is benched → skipped, not called.
    await drain(router.stream(REQ));
    expect(a.calls).toHaveLength(1);

    // Still benched after a full breaker cooldown — auth benches longer.
    await vi.advanceTimersByTimeAsync(config.breakerCooldownMs);
    await drain(router.stream(REQ));
    expect(a.calls).toHaveLength(1);

    // Once the auth cooldown fully elapses, anthropic is eligible and succeeds.
    await vi.advanceTimersByTimeAsync(
      config.authCooldownMs - config.breakerCooldownMs,
    );
    const revived = await drain(router.stream(REQ));
    expect(revived.error).toBeUndefined();
    expect(revived.events).toEqual([tok("A"), DONE]);
    expect(a.calls).toHaveLength(2);
  });

  it("[classify] a transient failure does not bench: the provider is retried next request", async () => {
    const a = makeMockProvider("anthropic", [
      { failBeforeFirstToken: { kind: "transient" } },
      { events: [tok("A"), DONE] },
    ]);
    const b = makeMockProvider("openai", { events: [tok("b"), DONE] });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
      breakerThreshold: 5,
    });

    // Request 1: anthropic transient-fails, openai wins.
    const first = await drain(router.stream(REQ));
    expect(first.events).toEqual([tok("b"), DONE]);
    expect(a.calls).toHaveLength(1);

    // Request 2 immediately: a transient failure did NOT bench anthropic, so it
    // is tried first again and now succeeds.
    const second = await drain(router.stream(REQ));
    expect(second.events).toEqual([tok("A"), DONE]);
    expect(a.calls).toHaveLength(2);
  });
});
