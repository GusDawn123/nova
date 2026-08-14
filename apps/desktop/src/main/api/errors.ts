import { z } from "zod";

/**
 * How a call to the Nova server can fail, as something the UI can branch on.
 *
 * Its own module, separate from `client.ts`, because `ipc/contract.ts` composes
 * this schema and the PRELOAD imports that contract. Left in `client.ts`, the
 * preload bundle would pull the whole api client — `fetch`, timers, abort
 * handling — into a process whose entire job is to hand five typed functions
 * across the bridge. A schema is data; the code that acts on it is not.
 *
 * The kinds are named for what the user should DO, not for what broke:
 *
 *   signed-out    — no token to send. Never reached the network.
 *   unauthorized  — the server rejected the token (401). Sign in again.
 *   unavailable   — the server cannot serve this (503). Not the user's doing.
 *   timeout       — no answer inside the budget. Retrying is reasonable.
 *   network       — the request never landed, or the answer was not readable.
 *   server        — some other non-2xx. Retrying rarely helps.
 *   schema        — a shape this build cannot read, i.e. the client is older
 *                   than the server.
 */
export const apiErrorKindSchema = z.enum([
  "signed-out",
  "unauthorized",
  "unavailable",
  "timeout",
  "network",
  "server",
  "schema",
]);

export type ApiErrorKind = z.infer<typeof apiErrorKindSchema>;

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; kind: ApiErrorKind; message: string };
