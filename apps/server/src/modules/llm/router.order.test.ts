import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMockProvider } from "./testing/mock-provider.js";
import {
  asAllProvidersFailed,
  DONE,
  drain,
  makeRouter,
  REQ,
  tok,
} from "./testing/router-harness.js";
import type { LlmErrorKind, ProviderId } from "./index.js";

/**
 * [order] `req.providerOrder` overrides config order for that request only;
 * providers named but not supplied are skipped; a later request without an
 * override reverts to config order.
 *
 * [empty] When every provider fails pre-commit (or the list is empty), `stream`
 * throws exactly one `AllProvidersFailedError` naming each provider's kind, in
 * bounded time — never a hang.
 */
describe("router [order] — per-request override", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[order] req.providerOrder overrides config order for that request only", async () => {
    const anthropic = makeMockProvider("anthropic", {
      events: [tok("A"), DONE],
    });
    const openai = makeMockProvider("openai", { events: [tok("B"), DONE] });
    const router = makeRouter([anthropic, openai], {
      defaultOrder: ["anthropic", "openai"],
    });

    // Override puts openai first: it wins, anthropic is never called.
    const overridden = await drain(
      router.stream({ ...REQ, providerOrder: ["openai", "anthropic"] }),
    );
    expect(overridden.events).toEqual([tok("B"), DONE]);
    expect(openai.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(0);

    // A subsequent request WITHOUT an override reverts to config order.
    const reverted = await drain(router.stream(REQ));
    expect(reverted.events).toEqual([tok("A"), DONE]);
    expect(anthropic.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(1); // unchanged; anthropic won this time
  });

  it("[order] providers named in the override but not supplied are skipped", async () => {
    const openai = makeMockProvider("openai", { events: [tok("B"), DONE] });
    const router = makeRouter([openai], { defaultOrder: ["openai"] });

    // google is named first but not supplied → skipped; openai wins.
    const { events, error } = await drain(
      router.stream({ ...REQ, providerOrder: ["google", "openai"] }),
    );

    expect(error).toBeUndefined();
    expect(events).toEqual([tok("B"), DONE]);
    expect(openai.calls).toHaveLength(1);
  });
});

describe("router [empty] — terminal exhaustion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[empty] every provider failing pre-commit throws one AllProvidersFailedError naming each kind", async () => {
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "auth" },
    });
    const b = makeMockProvider("openai", {
      failBeforeFirstToken: { kind: "transient" },
    });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
      ttftTimeoutMs: 1000,
    });

    const drained = drain(router.stream(REQ));
    await vi.advanceTimersByTimeAsync(2000);
    const { error } = await drained;

    const failed = asAllProvidersFailed(error);
    expect(failed.kind).toBe("all-providers-failed");
    const byProvider = new Map<ProviderId, LlmErrorKind>(
      failed.failures.map((f) => [f.provider, f.kind]),
    );
    expect(byProvider.get("anthropic")).toBe("auth");
    expect(byProvider.get("openai")).toBe("transient");
  });

  it("[empty] an empty providers array throws AllProvidersFailedError immediately", async () => {
    const router = makeRouter([], { defaultOrder: ["anthropic"] });

    const { events, error } = await drain(router.stream(REQ));

    expect(events).toHaveLength(0);
    const failed = asAllProvidersFailed(error);
    expect(failed.failures).toHaveLength(0);
  });

  it("[empty] when all providers are already benched, fails terminally without new calls", async () => {
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "auth" },
    });
    const b = makeMockProvider("openai", {
      failBeforeFirstToken: { kind: "auth" },
    });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
    });

    // Request 1: both auth-fail and get benched.
    const first = await drain(router.stream(REQ));
    asAllProvidersFailed(first.error);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);

    // Request 2: both benched → terminal failure with zero new calls.
    const second = await drain(router.stream(REQ));
    asAllProvidersFailed(second.error);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});
