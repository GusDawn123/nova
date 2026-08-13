import { z } from "zod";
import { meResponseSchema } from "@nova/shared";

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
