import { z } from "zod";
import {
  liveModeSchema,
  liveModelSchema,
  meResponseSchema,
} from "@nova/shared";

import { apiErrorKindSchema } from "../api/errors";
import { authActionResultSchema } from "../auth/errors";
import { authStateSchema } from "../auth/state";

/**
 * Every IPC payload, in both directions, as a schema.
 *
 * INBOUND is the one that matters for safety. `contextIsolation` stops the
 * renderer reading main's objects; it does not make anything the renderer SENDS
 * trustworthy. A compromised or simply buggy renderer hands `ipcMain` whatever
 * it likes — `undefined`, a number, an object with a `toString` that throws —
 * and TypeScript's view of the handler signature is fiction at that point. So
 * main parses on receipt, and the handler only ever sees a value that already
 * matched.
 *
 * OUTBOUND is parsed too, on the way out of main and again on the way into the
 * preload. Same posture the server takes with its own responses
 * (`meResponseSchema.parse(body)` in `apps/server/src/app.ts`): the boundary is
 * checked from both sides, so a wiring mistake surfaces where it was made
 * instead of as an undefined field three layers away.
 *
 * The result schemas are COMPOSED from the ones that own them — `auth/errors`,
 * `auth/state`, `api/client` — rather than restated here, so a new error kind
 * cannot be added in one place and silently dropped at the bridge.
 */

/**
 * Sign-in and sign-up credentials. `.strict()` because an unexpected key means
 * the two sides disagree about the contract, and the safe reading of that is
 * "reject", not "ignore and hope".
 *
 * The bar is deliberately low — a syntactically valid email and a non-empty
 * password. Supabase owns the real rules (minimum length, disposable domains,
 * rate limits) and its answer is what the user should be shown; duplicating a
 * password policy here would just add a second, wronger one.
 */
export const credentialsSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();
export type Credentials = z.infer<typeof credentialsSchema>;

/** main → renderer: the answer to `authSignIn` / `authSignUp` / `authSignOut`. */
export const authResultMessageSchema = authActionResultSchema;

/** main → renderer: the answer to `authGetState`, and the `authStateChanged` push. */
export const authStateMessageSchema = authStateSchema;
export type AuthStateMessage = z.infer<typeof authStateMessageSchema>;

/** main → renderer: the answer to `apiGetMe`. */
export const meResultMessageSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: meResponseSchema }),
  z.object({
    ok: z.literal(false),
    kind: apiErrorKindSchema,
    message: z.string(),
  }),
]);
export type MeResultMessage = z.infer<typeof meResultMessageSchema>;

/**
 * Both directions of the undetectability toggle. One boolean, strict both
 * ways: `privacySetState`'s payload in, and the answer to `privacyGetState` /
 * `privacySetState` plus the `privacyStateChanged` push out. `enabled: true`
 * means the windows are excluded from screen capture.
 */
export const privacyStateMessageSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type PrivacyStateMessage = z.infer<typeof privacyStateMessageSchema>;

/**
 * renderer → main: the pill window's content height, so main can size the
 * frameless window to it. Bounded because this number becomes OS window
 * geometry — a renderer bug (or a hostile renderer) must not be able to ask
 * for a zero-height or screen-swallowing window.
 */
export const pillResizeMessageSchema = z
  .object({ height: z.number().int().min(60).max(1200) })
  .strict();

/**
 * renderer → main: whether the pill window should let mouse clicks fall
 * through to whatever sits underneath it. The window is larger than the
 * visible pill (shadow and tooltip gutters), and a transparent window still
 * eats clicks in its invisible parts — so the renderer reports which region
 * the pointer is over and main flips `setIgnoreMouseEvents` to match.
 */
export const pillClickThroughMessageSchema = z
  .object({ clickThrough: z.boolean() })
  .strict();

/**
 * renderer → main: start a live session in the picked copilot mode AND the
 * picked live model (2026-08-20 pill picker). Both vocabularies are the shared
 * protocol's own (`liveModeSchema` / `liveModelSchema`) — the desktop cannot
 * invent a value the server would refuse. `model` optional = gpt, mirroring
 * the wire's own `live_model` contract.
 */
export const liveStartMessageSchema = z
  .object({ mode: liveModeSchema, model: liveModelSchema.optional() })
  .strict();

/** main → renderer: the answer to `liveStart` / `liveStop`. */
export const liveActionResultSchema = z
  .object({ ok: z.boolean(), message: z.string().optional() })
  .strict();
export type LiveActionResult = z.infer<typeof liveActionResultSchema>;

/** renderer → main: gate the session's audio intake without ending it. */
export const livePausedMessageSchema = z
  .object({ paused: z.boolean() })
  .strict();

/**
 * renderer → main: ask the copilot mid-call (2026-08-17, no-auto-response
 * decision — the copilot only speaks when asked). `text` is a typed question;
 * `null` is the empty-handed Answer press ("respond to what was just said").
 * The bound mirrors the wire's own `transcript.input` cap so a payload main
 * accepts can never be one the server refuses.
 */
export const liveAskMessageSchema = z
  .object({ text: z.string().min(1).max(2000).nullable() })
  .strict();

/**
 * main → renderer: the `liveEvent` push — everything the pill needs to render
 * a live call. Deliberately smaller than the server's wire protocol: the
 * renderer gets transcript rows and human-readable states, never vendor
 * vocabulary or session ids.
 */
export const liveSessionEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("status"),
      state: z.enum(["connecting", "live", "ended", "error"]),
      message: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("transcript"),
      final: z.boolean(),
      speaker: z.string().nullable(),
      text: z.string(),
      ts_ms: z.number(),
    })
    .strict(),
  /** Advisory only (device changes, provider failover) — never state. */
  z.object({ kind: z.literal("notice"), message: z.string() }).strict(),
  /**
   * One step of the focal suggestion's lifecycle, translated from the server's
   * `suggestion.*` events. `delta` APPENDS to the in-flight text; `done`
   * carries the complete final body (it REPLACES what streamed — the server
   * format-upgrades it); `discard` clears the pane (superseded, speculation
   * lost, or no response). `id` correlates the steps; the server discards the
   * old suggestion before starting a new one, so at most one is in flight.
   * The server's trigger-kind vocabulary is deliberately not forwarded.
   */
  z
    .object({
      kind: z.literal("suggestion"),
      phase: z.enum(["start", "delta", "done", "discard"]),
      id: z.string(),
      text: z.string(),
    })
    .strict(),
]);
export type LiveSessionEvent = z.infer<typeof liveSessionEventSchema>;

/** The sentence a renderer gets when what it sent did not parse. */
export const INVALID_CREDENTIALS_PAYLOAD_MESSAGE =
  "Enter an email address and a password.";

/**
 * The sentence a renderer gets when what MAIN sent did not parse. That is a
 * wiring bug in our own code rather than anything the user did — but it still
 * has to arrive as a typed result, because an exception thrown across IPC
 * reaches the UI as a stringified stack trace.
 */
export const INVALID_BRIDGE_RESPONSE_MESSAGE =
  "Nova's desktop bridge returned something unexpected.";
