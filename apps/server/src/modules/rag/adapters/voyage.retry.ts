import { RagError } from "../ports.js";

/**
 * Voyage rate-limit retry (Phase 4.8) — the backoff machinery for BACKGROUND-tier
 * Voyage calls (document embedding + rerank). Extracted from `voyage.ts` to keep
 * that file under the ~400-line cap (RULES §10); it stays inside `adapters/`, so
 * the "vendor HTTP lives in one place" invariant (RULES §2/§5) holds.
 *
 * LAW (adr-0005 §8 — retrieval can shrink, never delay): the live hot path NEVER
 * waits on a rate limiter. Only background calls back off. The hot-path query
 * embed drives {@link voyagePost} with `maxAttempts === 1`, so a 429 there is an
 * immediate typed failure (zero waits) and the live tier degrades instantly.
 *
 * Only HTTP 429 is retryable. Every OTHER failure — abort/timeout, network error,
 * non-2xx, malformed JSON — is an immediate `EMBEDDER_FAILED`, unchanged from the
 * pre-retry adapter. Request/response bodies are NEVER surfaced (they echo input
 * text), and neither is the API key.
 */

/** Max total attempts (1 original + up to 7 retries) for a background call. */
export const MAX_RETRY_ATTEMPTS = 8;
/** First backoff wait (~2s), doubled each attempt (adr-0005 §8 posture). */
const BASE_BACKOFF_MS = 2_000;
/** Ceiling on any single backoff wait. */
const MAX_BACKOFF_MS = 30_000;

/** One backoff-wait warn line. No content, no key — model/counts only. */
export interface VoyageBackoffLog {
  readonly vendor: "voyage";
  readonly model: string;
  readonly attempt: number;
  readonly wait_ms: number;
}

/** Default sink: exactly one warn-level JSON line per backoff wait. */
export function defaultLogBackoff(entry: VoyageBackoffLog): void {
  console.warn(JSON.stringify({ level: "warn", msg: "rag.backoff", ...entry }));
}

/**
 * Retry policy for one background call: the per-call vendor model (for the warn
 * line), the attempt ceiling (`1` = fail-fast hot path), and the backoff sink.
 */
export interface VoyageRetry {
  readonly model: string;
  readonly maxAttempts: number;
  readonly logBackoff: (entry: VoyageBackoffLog) => void;
}

/** Sleep `ms`, advanceable by fake timers in tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Parse a `Retry-After` header value expressed in SECONDS to milliseconds. Voyage
 * sends a numeric seconds value; the HTTP-date form is ignored (→ null, so the
 * caller falls back to exponential backoff). Never negative.
 */
function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  return null;
}

/**
 * Equal-jitter exponential backoff: half the capped delay plus up to half again,
 * so retries spread out instead of realigning into a thundering herd. `attempt`
 * is 1-based (the attempt that just 429'd). Bounded by {@link MAX_BACKOFF_MS}.
 */
function backoffMs(attempt: number): number {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/** Outcome of one POST attempt: parsed body, or a retryable 429 with its hint. */
type VoyagePostAttempt =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | null };

/**
 * POST JSON to Voyage under an {@link AbortController} deadline — ONE attempt.
 * Success → parsed body; HTTP 429 → a retryable signal carrying any `Retry-After`
 * hint; every OTHER failure → an immediate `EMBEDDER_FAILED` (cause preserved, the
 * response body never surfaced — it can echo input text).
 */
async function voyagePostOnce(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<VoyagePostAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    throw RagError.embedderFailed(
      aborted
        ? `voyage: request timed out after ${String(timeoutMs)}ms`
        : "voyage: network error",
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    // Retryable ONLY for background callers; the wrapper decides (adr-0005 §8).
    return { kind: "rate_limited", retryAfterMs: parseRetryAfterMs(res.headers) };
  }
  if (!res.ok) {
    // Status only — the response body can echo the input text; never surface it.
    throw RagError.embedderFailed(`voyage: HTTP ${String(res.status)}`, {
      cause: new Error(
        `voyage responded ${String(res.status)} ${res.statusText}`,
      ),
    });
  }

  try {
    const parsed: unknown = await res.json();
    return { kind: "ok", body: parsed };
  } catch (cause) {
    throw RagError.embedderFailed("voyage: malformed JSON response", { cause });
  }
}

/**
 * POST JSON to Voyage with rate-limit RETRY. On HTTP 429 it waits — honoring a
 * numeric `Retry-After` header when present, else equal-jitter exponential backoff
 * (~2s → 30s) — and retries up to `retry.maxAttempts` total, logging each wait.
 *
 * A caller with `maxAttempts === 1` (the hot-path query embed) NEVER waits: the
 * first 429 is an immediate `EMBEDDER_FAILED` (adr-0005 §8 — live RAG shrinks or
 * fails, never delays). Each attempt gets its OWN {@link AbortController} deadline
 * (per-request timeout semantics unchanged); the retry budget is bounded by attempt
 * count, not one shared clock. All non-429 failures propagate immediately.
 */
export async function voyagePost(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  retry: VoyageRetry,
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await voyagePostOnce(url, apiKey, body, timeoutMs);
    if (outcome.kind === "ok") return outcome.body;

    if (attempt >= retry.maxAttempts) {
      // Retries exhausted (or fail-fast): the 429 becomes the existing typed error,
      // status only — never the response body.
      throw RagError.embedderFailed("voyage: HTTP 429", {
        cause: new Error("voyage responded 429 Too Many Requests"),
      });
    }

    const waitMs = outcome.retryAfterMs ?? backoffMs(attempt);
    retry.logBackoff({ vendor: "voyage", model: retry.model, attempt, wait_ms: waitMs });
    await sleep(waitMs);
  }
}
