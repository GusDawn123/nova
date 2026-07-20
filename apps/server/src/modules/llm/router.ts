import type { LlmConfig } from "./config.js";
import type {
  ChatRequest,
  LlmProvider,
  LlmStreamEvent,
  Meter,
} from "./ports.js";

/**
 * Dependencies for {@link createLlmRouter}. `meter` is optional — omit it and
 * the router accounts through nothing (a real metering port is wired later).
 */
export interface LlmRouterDeps {
  providers: LlmProvider[];
  config: LlmConfig;
  meter?: Meter;
}

/**
 * The failover router surface consumed by the transport layer: a single
 * `stream` that races/falls-over across the configured providers and yields the
 * winner's events, or throws a typed {@link LlmError} when none survive.
 */
export interface LlmRouter {
  stream(
    req: ChatRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<LlmStreamEvent>;
}

/**
 * STUB — Phase 2.2 (TDD red step). The full behaviour suite in `router.*.test.ts`
 * is written first against this deliberately-throwing stub; Phase 2.3 replaces
 * the body with the real race / commit / stall / breaker / classify logic. Until
 * then every call throws so the suite is provably red for the right reason.
 */
export function createLlmRouter(deps: LlmRouterDeps): LlmRouter {
  void deps;
  return {
    stream(): AsyncIterable<LlmStreamEvent> {
      throw new Error("not implemented");
    },
  };
}
