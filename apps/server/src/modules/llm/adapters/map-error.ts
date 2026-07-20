import { isLlmError, LlmError } from "../errors.js";

/**
 * The single choke point where a raw vendor/transport error becomes one of our
 * typed {@link LlmError}s. Every adapter routes its `catch` through here so no
 * SDK error type ever leaks past the `adapters/` boundary (RULES: vendor SDKs
 * stay inside adapters).
 */

/** A human-readable message for any thrown value, without leaking the type. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a numeric HTTP status off a vendor SDK error, if it carries one. The
 * Anthropic, OpenAI, and Google SDKs all expose `.status`; some transports use
 * `.statusCode`. A non-integer or absent status yields `undefined`.
 */
export function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const raw = record["status"] ?? record["statusCode"];
  return typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
}

/** An abort — the caller/router aborted the shared signal, or the SDK said so. */
function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  // SDK abort errors don't share a stable `name`; the signal check above is the
  // primary path (the router aborts the signal before unwinding). This is a
  // belt-and-suspenders fallback for a DOMException-style abort.
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Collapse any thrown value into the `LlmError` taxonomy the router branches on:
 * an already-typed error passes through; an abort becomes `aborted`; an HTTP
 * status is classified `auth` vs `transient` via {@link LlmError.fromHttpStatus};
 * everything else (network/transport) is `transient` with the raw error as
 * `cause` for diagnosis.
 */
export function toLlmError(error: unknown, signal: AbortSignal): LlmError {
  if (isLlmError(error)) {
    return error;
  }
  if (isAbort(error, signal)) {
    return LlmError.aborted("provider request aborted", { cause: error });
  }
  const status = extractHttpStatus(error);
  if (status !== undefined) {
    return LlmError.fromHttpStatus(status, messageOf(error), { cause: error });
  }
  return LlmError.transient(messageOf(error), { cause: error });
}
