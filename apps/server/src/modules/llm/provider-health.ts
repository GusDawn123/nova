import type { LlmConfig } from "./config.js";
import type { ProviderId } from "./ports.js";

/**
 * Per-router-instance provider-health bookkeeping for the failover router: the
 * circuit breaker (consecutive transient failures) and the auth bench (a single
 * `auth` failure sidelines a provider far longer). State is keyed by
 * {@link ProviderId} and lives only inside one `createLlmRouter` instance — no
 * module-global mutable state.
 *
 * Timestamps are supplied by the caller (`Date.now()` under real time, or a
 * vitest fake clock in tests) so all timing is deterministic and testable.
 */

/** The kinds of pre-commit failure the health tracker distinguishes. */
export type FailureKind = "auth" | "transient";

interface ProviderState {
  /** Consecutive transient pre-commit failures since the last success. */
  consecutiveFailures: number;
  /** Breaker stays open (skip without calling) until this timestamp. */
  openUntil: number;
  /** An `auth` failure benches the provider until this timestamp. */
  benchedUntil: number;
}

export interface ProviderHealth {
  /** True when the provider may be attempted at `now` (not benched, not open). */
  isEligible(id: ProviderId, now: number): boolean;
  /** Record a pre-commit failure and update breaker/bench state. */
  recordFailure(id: ProviderId, kind: FailureKind, now: number): void;
  /** A committed success — resets the consecutive count and closes the breaker. */
  recordSuccess(id: ProviderId): void;
}

/** Build a fresh health tracker bound to one router's config. */
export function createProviderHealth(config: LlmConfig): ProviderHealth {
  const states = new Map<ProviderId, ProviderState>();

  const stateOf = (id: ProviderId): ProviderState => {
    const existing = states.get(id);
    if (existing) {
      return existing;
    }
    const fresh: ProviderState = {
      consecutiveFailures: 0,
      openUntil: 0,
      benchedUntil: 0,
    };
    states.set(id, fresh);
    return fresh;
  };

  return {
    isEligible(id: ProviderId, now: number): boolean {
      const state = states.get(id);
      if (!state) {
        return true;
      }
      // Auth bench takes precedence; both gates skip the provider without a call.
      return state.benchedUntil <= now && state.openUntil <= now;
    },

    recordFailure(id: ProviderId, kind: FailureKind, now: number): void {
      const state = stateOf(id);
      if (kind === "auth") {
        // One auth failure benches immediately — no threshold. It does NOT feed
        // the breaker count (a bad key is a different failure mode than a blip).
        state.benchedUntil = now + config.authCooldownMs;
        return;
      }
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= config.breakerThreshold) {
        state.openUntil = now + config.breakerCooldownMs;
      }
    },

    recordSuccess(id: ProviderId): void {
      const state = stateOf(id);
      state.consecutiveFailures = 0;
      state.openUntil = 0;
    },
  };
}
