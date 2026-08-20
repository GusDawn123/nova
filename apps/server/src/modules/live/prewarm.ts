import { type LlmRouter, type Meter } from "../llm/index.js";
import { assembleMeeting } from "../prompt/index.js";

import type { LiveLogger } from "./ports.js";

/**
 * Prompt-cache pre-warm (Natively reference, 2026-08-18 doc §4/§6): at
 * `session.start` a tiny request carries Brain A's byte-stable prefix to the
 * vendor so the prefix cache is WRITTEN before the user's first real ask —
 * without this, that write happens on the first question and the user eats the
 * full cold TTFT (their cited payoff: a large cached prefix cuts TTFT ~75-80%).
 *
 * It rides the SAME live router cascade as real suggestions, so it warms
 * whichever provider will actually serve (failover included), and the same
 * per-call meter, so the tiny spend lands on the ledger like every other
 * vendor call (adr-0007: no unmetered path). Fire-and-forget by design: it
 * never throws, and a failed warm costs nothing but the cold TTFT we already
 * had. Once per session by construction — the wiring calls it once per
 * conductor build.
 */

/**
 * The whole prompt-side cost of a warm: output length is handled in the
 * prompt (the ratified no-caps posture — a cap is a product decision, this
 * is not an answer), so the ask is the smallest one that completes.
 */
export const PREWARM_USER_MESSAGE = "Cache warm-up. Reply with exactly: ok";

/** A warm that hasn't answered by here is abandoned — it already missed its moment. */
const PREWARM_TIMEOUT_MS = 15000;

export interface PrewarmDeps {
  /** The live-tuned router (the same instance real suggestions ride). */
  router: LlmRouter;
  /** Per-call meter (`metering.meterFor(userId, meetingId)`) — the warm is billed. */
  meter?: Meter;
  logger?: LiveLogger;
  /** Attribution for the log line only (the meter already carries identity). */
  userId?: string;
  meetingId?: string;
  /** Overridable for tests. */
  timeoutMs?: number;
}

/**
 * Fire one tiny live-tier request so the vendor caches Brain A's stablePrefix.
 * Resolves when the warm finishes (or fails); NEVER rejects — callers
 * fire-and-forget it off the session-start path.
 */
export async function prewarmPromptCache(deps: PrewarmDeps): Promise<void> {
  // The prefix must be BYTE-IDENTICAL to what real asks send — the cache keys
  // on the prefix, and Brain A's stablePrefix is the same for every call.
  const { stablePrefix } = assembleMeeting({ transcript: [] });
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? PREWARM_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const stream = deps.router.stream(
      {
        messages: [
          { role: "system", content: stablePrefix },
          { role: "user", content: PREWARM_USER_MESSAGE },
        ],
        latencyTier: "live",
      },
      {
        signal: controller.signal,
        ...(deps.meter !== undefined ? { meter: deps.meter } : {}),
      },
    );
    let inputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    for await (const event of stream) {
      if (event.type === "done" && event.usage !== null) {
        inputTokens = event.usage.inputTokens;
        cachedInputTokens = event.usage.cachedInputTokens;
      }
    }
    deps.logger?.info?.(
      {
        user_id: deps.userId ?? null,
        meeting_id: deps.meetingId ?? null,
        duration_ms: Date.now() - startedAt,
        input_tokens: inputTokens ?? null,
        // >0 here means the cache was ALREADY warm (e.g. a recent session).
        cached_input_tokens: cachedInputTokens ?? null,
      },
      "live.prewarm_done",
    );
  } catch (err: unknown) {
    // Best-effort by contract: the session must start identically warm or cold.
    deps.logger?.error(
      {
        user_id: deps.userId ?? null,
        meeting_id: deps.meetingId ?? null,
        err,
      },
      "live.prewarm_failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}
