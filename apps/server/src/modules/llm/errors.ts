import type { ProviderId } from "./ports.js";

/**
 * The LLM error taxonomy. Every failure the router reasons about is one of these
 * `kind`s, so failover/circuit-breaker policy branches on a closed set rather
 * than sniffing vendor error strings:
 *
 * - `auth`      — 401/403-class; a bad/expired key. Benched FAR longer than a
 *                 blip (see `authCooldownMs`) because retrying won't help.
 * - `transient` — 5xx / timeout / network. Retryable; short breaker cooldown.
 * - `stall`     — a committed stream went silent past `stallTimeoutMs`.
 * - `aborted`   — the caller aborted; not a provider fault.
 * - `all-providers-failed` — terminal: the router exhausted the order. Carries a
 *                 per-provider failure summary for logs/telemetry.
 */
export type LlmErrorKind =
  | "auth"
  | "transient"
  | "stall"
  | "aborted"
  | "all-providers-failed";

/** One provider's contribution to an `all-providers-failed` summary. */
export interface ProviderFailure {
  readonly provider: ProviderId;
  readonly kind: LlmErrorKind;
  readonly message: string;
  /**
   * The raw thrown value, preserved for diagnosis — matters most when a
   * non-`LlmError` (an adapter bug) was defensively classified `transient`.
   * Absent for synthesized failures (e.g. "produced no tokens").
   */
  readonly cause?: unknown;
}

/** Optional cause, threaded to `Error`'s `cause` without violating exactOptional. */
interface LlmErrorOptions {
  cause?: unknown;
}

function errorOptions(options?: LlmErrorOptions): ErrorOptions | undefined {
  return options?.cause !== undefined ? { cause: options.cause } : undefined;
}

/**
 * Base LLM error, discriminated by `kind`. The four payload-free kinds
 * (`auth`/`transient`/`stall`/`aborted`) are built through the static factories
 * below; only the terminal kind carries extra invariant data, so it — and only
 * it — gets a subclass ({@link AllProvidersFailedError}) where that payload is
 * non-optional. This keeps us clear of the §10 anti-pattern (an optional field
 * meaningful for just one variant) without five near-identical empty subclasses.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string, options?: LlmErrorOptions) {
    super(message, errorOptions(options));
    this.name = "LlmError";
    this.kind = kind;
  }

  static auth(message = "authentication failed", options?: LlmErrorOptions) {
    return new LlmError("auth", message, options);
  }

  static transient(
    message = "transient provider failure",
    options?: LlmErrorOptions,
  ) {
    return new LlmError("transient", message, options);
  }

  static stall(message = "provider stream stalled", options?: LlmErrorOptions) {
    return new LlmError("stall", message, options);
  }

  static aborted(message = "operation aborted", options?: LlmErrorOptions) {
    return new LlmError("aborted", message, options);
  }

  static allProvidersFailed(failures: readonly ProviderFailure[]) {
    return new AllProvidersFailedError(failures);
  }

  /**
   * Classify a raw vendor error into an `auth` or `transient` `LlmError` — the
   * single place adapters turn an HTTP status into a taxonomy kind.
   */
  static fromHttpStatus(
    status: number,
    message: string,
    options?: LlmErrorOptions,
  ) {
    return classifyHttpStatus(status) === "auth"
      ? LlmError.auth(message, options)
      : LlmError.transient(message, options);
  }
}

/** Terminal router error: the ordered provider list was exhausted. */
export class AllProvidersFailedError extends LlmError {
  readonly failures: readonly ProviderFailure[];

  constructor(failures: readonly ProviderFailure[], message?: string) {
    super(
      "all-providers-failed",
      message ?? `all ${String(failures.length)} providers failed`,
    );
    this.name = "AllProvidersFailedError";
    this.failures = failures;
  }
}

/**
 * Map an HTTP status to the retry taxonomy. 401/403 are `auth` (a key problem —
 * retrying is pointless); everything else an adapter surfaces as an error
 * (5xx, 429, timeouts modelled as a status) is `transient` (worth failing over
 * and retrying later).
 */
export function classifyHttpStatus(status: number): "auth" | "transient" {
  return status === 401 || status === 403 ? "auth" : "transient";
}

/** Narrow an unknown thrown value to our taxonomy. */
export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError;
}
