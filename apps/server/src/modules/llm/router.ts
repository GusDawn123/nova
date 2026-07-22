import type { LlmConfig } from "./config.js";
import {
  AllProvidersFailedError,
  isLlmError,
  LlmError,
  type ProviderFailure,
} from "./errors.js";
import {
  noopMeter,
  type ChatRequest,
  type LlmProvider,
  type LlmStreamEvent,
  type Meter,
  type ProviderId,
  type UsageEntry,
} from "./ports.js";
import { createProviderHealth } from "./provider-health.js";

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
 *
 * `opts.meter` (Phase 6, adr-0007 §2) is the PER-CALL metering override: user
 * attribution travels with the call (via `metering.meterFor(userId, meetingId)`)
 * while the router — and its breaker/bench state — stays process-global. When
 * absent, the constructed default meter accounts the call. Exactly-once-at-`done`
 * semantics are identical either way.
 */
export interface LlmRouter {
  stream(
    req: ChatRequest,
    opts?: { signal?: AbortSignal; meter?: Meter },
  ): AsyncIterable<LlmStreamEvent>;
}

type DoneUsage = Extract<LlmStreamEvent, { type: "done" }>["usage"];

/**
 * Mutable per-attempt state shared between {@link runAttempt} and the failover
 * loop so the loop can tell WHY an attempt ended: whether it committed (and so
 * must never be failed over), and whether a timeout/caller-abort — rather than a
 * provider error — unwound it.
 */
interface AttemptContext {
  /** Set once the first NON-EMPTY token is seen; after this we never switch. */
  committed: boolean;
  /** Why the attempt's AbortController fired, if it did. */
  abortReason: "ttft" | "stall" | "caller" | undefined;
  /** Set once `done` triggered success/usage recording (exactly-once guard). */
  successRecorded: boolean;
}

/**
 * Create the failover router. Breaker/bench state lives in the closure — one
 * fresh tracker per router instance, never module-global.
 */
export function createLlmRouter(deps: LlmRouterDeps): LlmRouter {
  const { providers, config } = deps;
  const constructedMeter = deps.meter ?? noopMeter;
  const health = createProviderHealth(config);
  const byId = new Map<ProviderId, LlmProvider>(
    providers.map((provider) => [provider.id, provider]),
  );

  async function* stream(
    req: ChatRequest,
    opts?: { signal?: AbortSignal; meter?: Meter },
  ): AsyncGenerator<LlmStreamEvent> {
    // Per-call meter wins (adr-0007 §2): attribution travels with the call.
    const meter = opts?.meter ?? constructedMeter;
    const callerSignal = opts?.signal;
    if (callerSignal?.aborted) {
      throw LlmError.aborted();
    }

    // Order = per-request override (if any) else config default, filtered to the
    // providers actually supplied; names not supplied are silently skipped.
    const order = req.providerOrder ?? config.defaultOrder;
    const ordered = order
      .map((id) => byId.get(id))
      .filter((provider): provider is LlmProvider => provider !== undefined);

    const failures: ProviderFailure[] = [];

    for (const provider of ordered) {
      if (!health.isEligible(provider.id, Date.now())) {
        continue; // benched or breaker-open → skip WITHOUT calling
      }

      const ctx: AttemptContext = {
        committed: false,
        abortReason: undefined,
        successRecorded: false,
      };

      // Success is recorded the moment the terminal `done` event is OBSERVED —
      // before it is yielded — never after the attempt returns. A consumer that
      // stops consuming right after `done` (early `break`/`return` unwinds the
      // generator, skipping any code after `yield*`) must still be metered and
      // must still reset the winner's breaker count. Exactly-once guarded.
      const onDone = (usage: DoneUsage): void => {
        if (ctx.successRecorded) {
          return;
        }
        ctx.successRecorded = true;
        health.recordSuccess(provider.id);
        recordUsage(meter, provider.id, req, usage);
      };

      try {
        yield* runAttempt(provider, req, config, callerSignal, ctx, onDone);
      } catch (error) {
        if (ctx.committed) {
          // Committed: surface the outcome to the consumer, never fail over.
          throw translatePostCommit(error, ctx);
        }
        if (ctx.abortReason === "caller") {
          throw LlmError.aborted();
        }
        const kind = classifyPreCommit(error, ctx);
        failures.push({
          provider: provider.id,
          kind,
          message: messageOf(error),
          cause: error,
        });
        health.recordFailure(provider.id, kind, Date.now());
        continue;
      }

      if (!ctx.committed) {
        // Stream ended without ever producing a token — a pre-commit failure.
        failures.push({
          provider: provider.id,
          kind: "transient",
          message: "provider produced no tokens",
        });
        health.recordFailure(provider.id, "transient", Date.now());
        continue;
      }

      // Committed and completed cleanly. A done-less clean end still counts as
      // a breaker success (there is just no usage to meter without a `done`).
      if (!ctx.successRecorded) {
        health.recordSuccess(provider.id);
      }
      return;
    }

    throw new AllProvidersFailedError(failures);
  }

  return { stream };
}

/**
 * Drive one provider attempt: race the first non-empty token against
 * `ttftTimeoutMs`, then guard each post-commit gap against `stallTimeoutMs`.
 * Timeouts and the caller's signal are enforced by aborting a per-attempt
 * controller; the mock/adapter reacts by rejecting its pending step, which
 * unwinds the loop below — no `Promise.race`, so no abandoned pending `.next()`
 * promises to leak as unhandled rejections.
 *
 * The provider iterator is driven MANUALLY (not `for await`) so that when the
 * consumer stops early (`break`/`return` unwinds us at a `yield`), the cleanup
 * order is ours: abort the attempt controller FIRST (so the provider observes
 * the abort), then close the provider iterator. A plain `for await` would close
 * the provider before our `finally` could abort it.
 */
async function* runAttempt(
  provider: LlmProvider,
  req: ChatRequest,
  config: LlmConfig,
  callerSignal: AbortSignal | undefined,
  ctx: AttemptContext,
  onDone: (usage: DoneUsage) => void,
): AsyncGenerator<LlmStreamEvent> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let streamCompleted = false;
  let doneSeen = false;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const armTimer = (reason: "ttft" | "stall", ms: number): void => {
    clearTimer();
    timer = setTimeout(() => {
      ctx.abortReason = reason;
      controller.abort();
    }, ms);
  };
  const onCallerAbort = (): void => {
    ctx.abortReason = "caller";
    controller.abort();
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const iterator = provider
    .stream(req, controller.signal)
    [Symbol.asyncIterator]();

  try {
    armTimer("ttft", config.ttftTimeoutMs);
    for (;;) {
      const result = await iterator.next();
      clearTimer(); // a step landed → cancel the pending ttft/stall deadline
      if (result.done === true) {
        streamCompleted = true;
        return;
      }
      const event = result.value;

      if (!ctx.committed) {
        if (event.type === "token" && event.text !== "") {
          ctx.committed = true;
        } else {
          // Empty token or stray pre-commit event: does not commit. Keep the
          // ttft window running and wait for a real first token.
          armTimer("ttft", config.ttftTimeoutMs);
          continue;
        }
      }

      if (event.type === "done") {
        doneSeen = true;
        onDone(event.usage); // record success BEFORE the consumer can bail
      }
      yield event;
      armTimer("stall", config.stallTimeoutMs); // guard the gap to the next event
    }
  } finally {
    clearTimer();
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
    if (!streamCompleted) {
      // Unwound early (consumer break, timeout, caller abort, provider throw).
      // Abort the attempt FIRST so the provider observes it as an abort — unless
      // the stream already logically finished with `done` (a clean stop) — then
      // close its iterator, swallowing secondary errors from the abandoned
      // generator so nothing surfaces as an unhandled rejection.
      if (!doneSeen && !controller.signal.aborted) {
        controller.abort();
      }
      try {
        await iterator.return?.();
      } catch {
        // Deliberately swallowed: the attempt is already being abandoned.
      }
    }
  }
}

/** Post-commit outcome → the typed error the consumer receives. */
function translatePostCommit(error: unknown, ctx: AttemptContext): LlmError {
  if (ctx.abortReason === "stall") {
    return LlmError.stall();
  }
  if (ctx.abortReason === "caller") {
    return LlmError.aborted();
  }
  // A genuine mid-stream provider error (e.g. the vendor died) surfaces as-is.
  if (isLlmError(error)) {
    return error;
  }
  return LlmError.transient(messageOf(error), { cause: error });
}

/**
 * Pre-commit failure → the breaker/summary kind. A ttft timeout is transient.
 *
 * DELIBERATE (orchestrator ruling): a non-`LlmError` thrown pre-commit — an
 * adapter bug, since adapters contractually throw typed errors — is classified
 * `transient` so the router fails over instead of crashing the stream. The raw
 * error is preserved as `cause` on the failure-summary entry for diagnosis.
 * Revisit when real adapters land.
 */
function classifyPreCommit(
  error: unknown,
  ctx: AttemptContext,
): "auth" | "transient" {
  if (ctx.abortReason === "ttft") {
    return "transient";
  }
  return isLlmError(error) && error.kind === "auth" ? "auth" : "transient";
}

/** Report the winner's usage to the meter (usage may be `null`: no counts). */
function recordUsage(
  meter: Meter,
  provider: ProviderId,
  req: ChatRequest,
  usage: DoneUsage,
): void {
  const entry: UsageEntry = { provider };
  if (req.model !== undefined) {
    entry.model = req.model;
  }
  if (usage) {
    if (usage.inputTokens !== undefined) {
      entry.inputTokens = usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
      entry.outputTokens = usage.outputTokens;
    }
  }
  meter.recordUsage(entry);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bind a {@link Meter} onto every `stream` call of a router — the convenience
 * consumers (notes pipeline, follow-up) use to thread `metering.meterFor(...)`
 * through code that only sees an {@link LlmRouter}. Purely additive: any explicit
 * `opts` (signal) pass through; an explicit per-call `opts.meter` on the wrapped
 * router would be overridden by design (the closest binding wins is NOT wanted
 * here — the wrapper IS the per-call meter).
 */
export function withMeter(router: LlmRouter, meter: Meter): LlmRouter {
  return {
    stream(req, opts) {
      return router.stream(req, { ...opts, meter });
    },
  };
}
