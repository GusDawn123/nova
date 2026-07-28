import {
  SttAuthError,
  SttProtocolError,
  SttTransientError,
  type SttError,
  type SttErrorKind,
} from "../ports.js";

/**
 * Vendor-error taxonomy mapping (Phase 3.5). Both SDKs report failures as plain
 * `Error`s (mid-stream `error` events, rejected connects) or WebSocket close
 * codes. The engine's retry policy keys off {@link SttErrorKind}, so an adapter
 * must NEVER leak a raw SDK error up — it maps every failure to a typed
 * {@link SttError} here. Kept SDK-free and pure so the classification is unit
 * tested directly against strings/codes.
 *
 * Classification is intentionally conservative: anything we cannot positively
 * identify as `auth` or `protocol` is `transient`, because retrying the same
 * vendor on a blip is cheap and correct, whereas mislabeling a transient blip as
 * `auth` would bench a healthy vendor and force a needless failover.
 */

/** Substrings that positively identify a credentials/billing failure (retry is pointless). */
const AUTH_SIGNALS = [
  "unauthorized",
  "unauthenticated",
  "forbidden",
  "invalid api key",
  "invalid_api_key",
  "invalid credentials",
  "authentication failed",
  "not authorized",
  "insufficient funds",
  "payment",
  "quota",
  "account",
];

/** Substrings that identify a broken streaming contract (parse/shape failure). */
const PROTOCOL_SIGNALS = [
  "parse",
  "unexpected message",
  "malformed",
  "invalid frame",
  "protocol error",
  "unparseable",
];

/**
 * WebSocket close codes that mean "credentials rejected". 4001/4003/4008 are the
 * range both AssemblyAI and Deepgram use for auth/quota rejections; 1008 is the
 * RFC 6455 "policy violation" a server sends when it refuses the handshake.
 */
const AUTH_CLOSE_CODES = new Set([1008, 4001, 4003, 4008]);

/** HTTP status codes that mean "credentials rejected" when surfaced in an error. */
const AUTH_HTTP_CODES = ["401", "402", "403", "429"];

/** Classify a free-text error message (case-insensitive) into a retry kind. */
export function classifyVendorErrorText(text: string): SttErrorKind {
  const lower = text.toLowerCase();
  if (AUTH_SIGNALS.some((signal) => lower.includes(signal))) return "auth";
  if (AUTH_HTTP_CODES.some((code) => lower.includes(code))) return "auth";
  if (PROTOCOL_SIGNALS.some((signal) => lower.includes(signal)))
    return "protocol";
  return "transient";
}

/** Classify a WebSocket close (code + optional reason) into a retry kind. */
export function classifyVendorClose(code: number, reason = ""): SttErrorKind {
  if (AUTH_CLOSE_CODES.has(code)) return "auth";
  if (reason) return classifyVendorErrorText(reason);
  return "transient";
}

/** Extract a human-readable message from an unknown thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown vendor error";
}

/** Build the {@link SttError} subclass for a given kind, preserving the cause. */
export function sttErrorFor(
  kind: SttErrorKind,
  message: string,
  cause: unknown,
): SttError {
  const options = cause instanceof Error ? { cause } : undefined;
  switch (kind) {
    case "auth":
      return new SttAuthError(message, options);
    case "protocol":
      return new SttProtocolError(message, options);
    case "transient":
      return new SttTransientError(message, options);
  }
}

/**
 * Map an unknown SDK error to a typed {@link SttError}. `vendorId` prefixes the
 * message for diagnostics; the raw SDK error is preserved as `cause` (never
 * re-thrown as-is). Optional `closeCode` lets a socket-close handler override
 * text-based classification with the more authoritative close code.
 */
export function toSttError(
  vendorId: string,
  err: unknown,
  closeCode?: number,
): SttError {
  const raw = messageOf(err);
  const kind =
    closeCode !== undefined
      ? classifyVendorClose(closeCode, raw)
      : classifyVendorErrorText(raw);
  return sttErrorFor(kind, `${vendorId}: ${raw}`, err);
}
