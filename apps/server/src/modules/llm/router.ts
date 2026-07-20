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
 */
export interface LlmRouter {
  stream(
    req: ChatRequest,
    opts?: { signal?: AbortSignal },
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
  /** Usage from the `done` event, once seen (`undefined` = no `done` yet). */
  doneUsage: DoneUsage | undefined;
}

/**
 * Create the failover router. Breaker/bench state lives in the closure — one
 * fresh tracker per router instance, never module-global.
 */
export function createLlmRouter(deps: LlmRouterDeps): LlmRouter {
  const { providers, config } = deps;
  const meter = deps.meter ?? noopMeter;
  const health = createProviderHealth(config);
  const byId = new Map<ProviderId, LlmProvider>(
    providers.map((provider) => [provider.id, provider]),
  );

  async function* stream(
    req: ChatRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<LlmStreamEvent> {
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
        doneUsage: undefined,
      };

      try {
        yield* runAttempt(provider, req, config, callerSignal, ctx);
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

      // Committed and completed cleanly: the winner.
      health.recordSuccess(provider.id);
      recordUsage(meter, provider.id, req, ctx.doneUsage);
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
 * controller; the mock/adapter reacts by rejecting, which unwinds the
 * `for await` below — no `Promise.race` and thus no abandoned pending `.next()`
 * promises to leak as unhandled rejections.
 */
async function* runAttempt(
  provider: LlmProvider,
  req: ChatRequest,
  config: LlmConfig,
  callerSignal: AbortSignal | undefined,
  ctx: AttemptContext,
): AsyncGenerator<LlmStreamEvent> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let streamCompleted = false;

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

  try {
    armTimer("ttft", config.ttftTimeoutMs);
    for await (const event of provider.stream(req, controller.signal)) {
      clearTimer(); // an event arrived → cancel the pending ttft/stall deadline

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
        ctx.doneUsage = event.usage;
      }
      yield event;
      armTimer("stall", config.stallTimeoutMs); // guard the gap to the next event
    }
    streamCompleted = true;
  } finally {
    clearTimer();
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
    // Abort a losing/aborted attempt so it stops promptly. Harmless on a clean
    // finish (the provider has already detached its abort listener).
    if (!streamCompleted && !controller.signal.aborted) {
      controller.abort();
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

/** Pre-commit failure → the breaker/summary kind. A ttft timeout is transient. */
function classifyPreCommit(
  error: unknown,
  ctx: AttemptContext,
): "auth" | "transient" {
  if (ctx.abortReason === "ttft") {
    return "transient";
  }
  return isLlmError(error) && error.kind === "auth" ? "auth" : "transient";
}

/** Record usage for the winner exactly once, only when a `done` was seen. */
function recordUsage(
  meter: Meter,
  provider: ProviderId,
  req: ChatRequest,
  usage: DoneUsage | undefined,
): void {
  if (usage === undefined) {
    return; // no `done` event → nothing to meter
  }
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
