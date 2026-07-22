import { describe, expect, it } from "vitest";

import { toLlmError } from "./adapters/map-error.js";
import { classifyHttpStatus, isLlmError, LlmError } from "./errors.js";
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
 * [invalid] The `invalid` error class (Phase 6, adr-0007 consequences; live
 * evidence: the 2026-07-22 Anthropic credit outage returned 400s the router
 * classed `transient`, burning a failover sweep per call). Semantics:
 *
 *   - HTTP 400/404/422 → `invalid` (the request/credit/model is bad AT this
 *     provider; retrying the same provider is pointless).
 *   - The router fails over IMMEDIATELY to the next provider — the invalid
 *     provider is attempted exactly ONCE per stream (no same-provider
 *     retry/backoff).
 *   - `invalid` DOES count toward that provider's circuit breaker (repeated
 *     invalids — e.g. credit-exhausted 400s — trip it open, ending the
 *     per-call failover-sweep burn).
 *   - Auth 401/403 bench semantics are UNCHANGED (single failure → long bench,
 *     no breaker count).
 */

describe("classifyHttpStatus — the invalid class", () => {
  it("[invalid] 400/404/422 classify as invalid", () => {
    expect(classifyHttpStatus(400)).toBe("invalid");
    expect(classifyHttpStatus(404)).toBe("invalid");
    expect(classifyHttpStatus(422)).toBe("invalid");
  });

  it("[invalid] auth and transient classes are unchanged", () => {
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("auth");
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyHttpStatus(status)).toBe("transient");
    }
  });

  it("[invalid] LlmError.fromHttpStatus and the factory build invalid errors", () => {
    expect(LlmError.fromHttpStatus(400, "credit exhausted").kind).toBe(
      "invalid",
    );
    expect(LlmError.fromHttpStatus(404, "no such model").kind).toBe("invalid");
    expect(LlmError.invalid().kind).toBe("invalid");
    expect(isLlmError(LlmError.invalid())).toBe(true);
  });

  it("[invalid] toLlmError maps a vendor 400-status error to invalid", () => {
    const raw = Object.assign(new Error("400 bad request"), { status: 400 });
    const mapped = toLlmError(raw, new AbortController().signal);
    expect(mapped.kind).toBe("invalid");
    expect(mapped.cause).toBe(raw);
  });
});

describe("router [invalid] — immediate failover, once per provider, breaker counts", () => {
  const WIN = [tok("ok"), doneWith({ inputTokens: 1, outputTokens: 2 })];

  it("[invalid] fails over immediately; the invalid provider is called exactly once", async () => {
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "invalid" },
    });
    const b = makeMockProvider("openai", { events: WIN });
    const router = makeRouter([a, b], {
      defaultOrder: ["anthropic", "openai"],
    });

    const { events, error } = await drain(router.stream(REQ));

    expect(error).toBeUndefined();
    expect(events.some((e) => e.type === "done")).toBe(true);
    // NO same-provider retry: one attempt on the invalid provider, then failover.
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("[invalid] the all-providers summary carries kind 'invalid'", async () => {
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "invalid" },
    });
    const router = makeRouter([a], { defaultOrder: ["anthropic"] });

    const { error } = await drain(router.stream(REQ));

    const summary = asAllProvidersFailed(error);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.kind).toBe("invalid");
  });

  it("[invalid] repeated invalids trip the provider's breaker (skipped without a call)", async () => {
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "invalid" },
    });
    const b = makeMockProvider("openai", { events: WIN });
    const router = makeRouter(
      [a, b],
      { defaultOrder: ["anthropic", "openai"], breakerThreshold: 2 },
    );

    await drain(router.stream(REQ)); // invalid #1 (a called)
    await drain(router.stream(REQ)); // invalid #2 → breaker trips open
    await drain(router.stream(REQ)); // breaker open → a skipped WITHOUT a call

    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(3);
  });

  it("[invalid] auth bench semantics unchanged: one 401 benches without a breaker count", async () => {
    const a = makeMockProvider("anthropic", {
      failBeforeFirstToken: { kind: "auth" },
    });
    const b = makeMockProvider("openai", { events: WIN });
    const router = makeRouter(
      [a, b],
      // breakerThreshold high: proves the SKIP comes from the auth bench, not
      // breaker accumulation.
      { defaultOrder: ["anthropic", "openai"], breakerThreshold: 99 },
    );

    await drain(router.stream(REQ)); // auth failure → benched immediately
    await drain(router.stream(REQ)); // benched → skipped without a call

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(2);
  });
});
