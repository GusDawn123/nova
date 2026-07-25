import { z } from "zod";

/**
 * Live-call wire protocol (Phase 3) — the typed envelope exchanged over the one
 * authenticated WebSocket per call (`GET /live`). Audio frames travel UP as raw
 * binary WS frames; every OTHER message is one of these JSON events.
 *
 * Design source: `docs/DESIGN/live-pipeline.md` §Wire protocol. This module
 * defines the socket + protocol contract only — nothing here emits STT or
 * suggestion events yet (Phases 3.3–5 / 7 hang vendors off the server seam);
 * the `suggestion.*` shapes are defined now so the protocol is complete.
 *
 * NAMING: snake_case on the wire, everywhere (field names AND event `type`
 * discriminants), matching the repo's SQL/HTTP wire convention (`user_id`,
 * `request_id`). The design doc's `{ text, isFinal, speaker, ts }` shorthand is
 * rendered here as `{ text, is_final, speaker, ts_ms }`. Consumers get the
 * camelCase-vs-snake_case choice made for them: parse with these schemas and
 * read snake_case fields; no twin hand-written types (RULES: `z.infer` only).
 *
 * VERSIONING: every event carries `v: 1`. A future breaking change bumps the
 * literal and widens the union; a peer that sees an unknown `v` fails the parse
 * (closed set) rather than silently mis-reading fields.
 */

/** Current protocol version, stamped on every event as `v`. */
export const LIVE_PROTOCOL_VERSION = 1 as const;

const version = z.literal(LIVE_PROTOCOL_VERSION);

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/**
 * Open a live session. `meeting_id` ties the socket to an existing meeting row.
 * `echo` is a TEST-ONLY diagnostic: when set, the server (only outside
 * production) echoes each binary audio frame's byte length back as an
 * `audio.echo` event so tests can prove binary transit without a real STT
 * vendor. Ignored in production.
 */
export const sessionStartSchema = z.object({
  v: version,
  type: z.literal("session.start"),
  meeting_id: z.string().uuid(),
  echo: z.boolean().optional(),
});

/**
 * Protocol MARKER only. Real audio never arrives as JSON — it travels as raw
 * binary WS frames (16kHz PCM, 40–80ms), handed to the server's audio seam. This
 * variant exists so the union documents the full up-channel; a JSON `audio.frame`
 * is answered with an `invalid_event` error (audio must be binary).
 */
export const audioFrameMarkerSchema = z.object({
  v: version,
  type: z.literal("audio.frame"),
});

/**
 * WHICH of the two things a `transcript.input` means. The channel was built to
 * carry both (Phase 7) and the server could not tell them apart — so every
 * question typed AT the copilot was recorded as a line the OTHER party spoke,
 * and flowed on into post-call notes and RAG memory as a fact about the call.
 *
 *   utterance         The user is typing what was SAID (mic off / noisy room).
 *                     Attributed to "them", echoed, persisted, indexed — the
 *                     original Phase 7 behavior, and correct for this meaning.
 *   copilot_question  The user is asking their COPILOT something. Answered (that
 *                     is the point), echoed back as the user's OWN turn, and
 *                     deliberately NOT persisted: it is not part of the call, so
 *                     it must never reach the transcript, the notes, or memory.
 *
 * OPTIONAL, and an omitted value means `utterance` — the field is additive, so a
 * client older than this schema keeps its exact prior behavior rather than
 * silently changing what gets stored.
 */
export const transcriptInputOriginSchema = z.enum([
  "utterance",
  "copilot_question",
]);
export type TranscriptInputOrigin = z.infer<typeof transcriptInputOriginSchema>;

/**
 * A TYPED utterance from the conversation (Phase 7, decision 2026-07-22): the
 * user types what was said — or a question to the copilot — instead of (or
 * alongside) the mic. The server treats it exactly like a FINAL transcript
 * utterance from the OTHER party: it is echoed back as a `transcript.final`
 * (speaker "them"), enters the rolling transcript + persistence, runs the
 * trigger gate, and can stream a real suggestion. A first-class product surface
 * (typed input to your copilot mid-call), not a dev affordance. Only valid
 * AFTER `session.start` (else a typed `input_before_start` error). Bounded at
 * 2000 chars so one message can't balloon the prompt window.
 */
export const transcriptInputSchema = z.object({
  v: version,
  type: z.literal("transcript.input"),
  text: z.string().min(1).max(2000),
  origin: transcriptInputOriginSchema.optional(),
});

/** Gracefully end the session; triggers server-side teardown. */
export const sessionEndSchema = z.object({
  v: version,
  type: z.literal("session.end"),
});

/** Heartbeat. The server replies with `pong`. */
export const pingSchema = z.object({
  v: version,
  type: z.literal("ping"),
});

/** Every JSON message a client may send up the socket. */
export const clientLiveEventSchema = z.discriminatedUnion("type", [
  sessionStartSchema,
  audioFrameMarkerSchema,
  transcriptInputSchema,
  sessionEndSchema,
  pingSchema,
]);

export type ClientLiveEvent = z.infer<typeof clientLiveEventSchema>;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Session accepted; carries the server-generated session id (survives resume). */
export const sessionReadySchema = z.object({
  v: version,
  type: z.literal("session.ready"),
  session_id: z.string().uuid(),
});

/** Interim (unstable) transcript hypothesis; may be revised by a later final. */
export const transcriptPartialSchema = z.object({
  v: version,
  type: z.literal("transcript.partial"),
  text: z.string(),
  speaker: z.string().nullable(),
  ts_ms: z.number(),
});

/**
 * Committed transcript utterance. Same shape as the partial plus the literal
 * `is_final: true` — the discriminant is `type`, but the flag lets a consumer
 * that keeps both in one buffer tell them apart without re-checking `type`.
 */
export const transcriptFinalSchema = z.object({
  v: version,
  type: z.literal("transcript.final"),
  text: z.string(),
  speaker: z.string().nullable(),
  ts_ms: z.number(),
  is_final: z.literal(true),
});

/** STT vendor failover happened; relaying continues transparently. */
export const providerSwitchedSchema = z.object({
  v: version,
  type: z.literal("provider_switched"),
  from: z.string(),
  to: z.string(),
});

/** A suggestion stream is starting; `suggestion_id` correlates its lifecycle. */
export const suggestionStartSchema = z.object({
  v: version,
  type: z.literal("suggestion.start"),
  suggestion_id: z.string().uuid(),
  kind: z.string(),
});

/** A coalesced token batch (~50ms) appended to an in-flight suggestion. */
export const suggestionDeltaSchema = z.object({
  v: version,
  type: z.literal("suggestion.delta"),
  suggestion_id: z.string().uuid(),
  text: z.string(),
});

/** The suggestion completed; `text` is its final, format-upgraded body. */
export const suggestionDoneSchema = z.object({
  v: version,
  type: z.literal("suggestion.done"),
  suggestion_id: z.string().uuid(),
  text: z.string(),
});

/** The suggestion was abandoned (speculation lost the reconcile); drop the card. */
export const suggestionDiscardSchema = z.object({
  v: version,
  type: z.literal("suggestion.discard"),
  suggestion_id: z.string().uuid(),
  reason: z.string(),
});

/** Machine-readable reason an event/frame was rejected. Closed set. */
export const liveErrorCodeSchema = z.enum([
  "invalid_json",
  "invalid_event",
  "audio_before_start",
  "already_started",
  // The `session.start` meeting_id does not name a live meeting owned by the
  // authenticated caller (missing / wrong-owner / soft-deleted). Emitted just
  // before the server policy-closes the socket — a spoofed parent never starts a
  // session (Phase 4 review C1). "Forbidden" is deliberately undifferentiated
  // from "not found" so the code leaks nothing about another user's meeting ids.
  "meeting_forbidden",
  // Phase 6 enforcement codes (adr-0007; additive, no v bump — the app renders
  // these as paywall / blocked states):
  //   quota_exceeded    — the caller's plan quota is spent (session-start check
  //                       or mid-stream recheck); policy close follows.
  //   daily_cap_reached — the GLOBAL daily spend kill-switch tripped; new
  //                       sessions/work refused, in-flight finishes (Task 4).
  //   concurrent_session — one live session per user; a second start is refused
  //                       (Task 4).
  "quota_exceeded",
  "daily_cap_reached",
  "concurrent_session",
  // Phase 7 (additive, no v bump): a `transcript.input` arrived before
  // `session.start` — mirrors `audio_before_start` for the typed-input channel.
  "input_before_start",
  "internal",
]);

export type LiveErrorCode = z.infer<typeof liveErrorCodeSchema>;

/**
 * A recoverable, per-message error. The socket stays OPEN — a single bad frame
 * never tears down the session (fatal conditions use WS close codes instead,
 * e.g. 4401 unauthorized / 4503 unavailable at upgrade).
 */
export const liveErrorSchema = z.object({
  v: version,
  type: z.literal("error"),
  code: liveErrorCodeSchema,
  message: z.string(),
});

/** Heartbeat reply. */
export const pongSchema = z.object({
  v: version,
  type: z.literal("pong"),
});

/**
 * TEST-ONLY diagnostic: reports the byte length of a received binary audio
 * frame. Emitted only when a session opened with `echo: true` outside
 * production; proves the binary path end to end before a real STT vendor exists.
 */
export const audioEchoSchema = z.object({
  v: version,
  type: z.literal("audio.echo"),
  bytes: z.number().int().nonnegative(),
});

/** Every JSON message the server may send down the socket. */
export const serverLiveEventSchema = z.discriminatedUnion("type", [
  sessionReadySchema,
  transcriptPartialSchema,
  transcriptFinalSchema,
  providerSwitchedSchema,
  suggestionStartSchema,
  suggestionDeltaSchema,
  suggestionDoneSchema,
  suggestionDiscardSchema,
  liveErrorSchema,
  pongSchema,
  audioEchoSchema,
]);

export type ServerLiveEvent = z.infer<typeof serverLiveEventSchema>;

/**
 * Parse an untrusted inbound value (already JSON-decoded) as a client event.
 * Returns a zod result so the server maps a failure to an `error` event without
 * throwing (RULES: zod-parse every boundary; no exceptions across the seam).
 */
export function parseClientEvent(
  data: unknown,
): z.SafeParseReturnType<unknown, ClientLiveEvent> {
  return clientLiveEventSchema.safeParse(data);
}
