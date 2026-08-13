import { BrowserWindow, ipcMain } from "electron";
import type { z } from "zod";

import type { ApiClient } from "../api/client";
import type { AuthActionResult } from "../auth/errors";
import type { AuthService } from "../auth/service";
import { IpcChannel } from "./channels";
import {
  authResultMessageSchema,
  authStateMessageSchema,
  credentialsSchema,
  meResultMessageSchema,
  INVALID_BRIDGE_RESPONSE_MESSAGE,
  INVALID_CREDENTIALS_PAYLOAD_MESSAGE,
  type AuthStateMessage,
  type MeResultMessage,
} from "./contract";

/**
 * Wiring only. Every decision lives in the auth service or the api client; this
 * file connects them to channels and checks what crosses.
 *
 * On direction: renderer → main is parsed because the renderer is the process
 * that loads untrusted content, and `contextIsolation` stops it reaching into
 * main without making anything it SENDS trustworthy. main → renderer is checked
 * too, which is a different bet — not about trust but about catching our own
 * wiring mistakes at the boundary where they were made.
 *
 * Both directions use `safeParse`, and that is the whole point. An outbound
 * `.parse()` would THROW inside the handler, `ipcMain.handle` turns a throw into
 * a rejected promise, and the renderer would receive a stringified stack trace
 * instead of the typed failure both sides were written to exchange. A contract
 * violation must not become a worse contract violation on the way out.
 */
export interface IpcDeps {
  auth: AuthService;
  api: ApiClient;
}

const INVALID_CREDENTIALS_RESULT: AuthActionResult = {
  ok: false,
  kind: "invalid-request",
  message: INVALID_CREDENTIALS_PAYLOAD_MESSAGE,
};

/** Our own bug, reported in the vocabulary the caller already handles. */
const OFF_CONTRACT_AUTH_RESULT: AuthActionResult = {
  ok: false,
  kind: "unknown",
  message: INVALID_BRIDGE_RESPONSE_MESSAGE,
};

const OFF_CONTRACT_ME_RESULT: MeResultMessage = {
  ok: false,
  kind: "schema",
  message: INVALID_BRIDGE_RESPONSE_MESSAGE,
};

/**
 * Paths and codes only. A rejected payload can contain an email or a token, and
 * a log line is the wrong place for either.
 */
function reportOffContract(channel: string, error: z.ZodError): void {
  console.error(
    `[ipc] ${channel} produced a value the contract does not allow`,
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
    })),
  );
}

/** Validate an outbound payload, falling back rather than throwing. */
function outbound<T>(
  channel: string,
  schema: z.ZodType<T>,
  value: unknown,
  fallback: T,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  reportOffContract(channel, parsed.error);
  return fallback;
}

/** Registers every handler and the auth push. Returns its own teardown. */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const { auth, api } = deps;

  ipcMain.handle(IpcChannel.authGetState, () =>
    outbound(
      IpcChannel.authGetState,
      authStateMessageSchema,
      auth.getState(),
      unreadableState(),
    ),
  );

  ipcMain.handle(IpcChannel.authSignIn, async (_event, payload: unknown) => {
    const parsed = credentialsSchema.safeParse(payload);
    // Answered in the action's own vocabulary rather than by throwing, for the
    // same reason the outbound checks exist.
    const result = parsed.success
      ? await auth.signIn(parsed.data)
      : INVALID_CREDENTIALS_RESULT;
    return outbound(
      IpcChannel.authSignIn,
      authResultMessageSchema,
      result,
      OFF_CONTRACT_AUTH_RESULT,
    );
  });

  ipcMain.handle(IpcChannel.authSignUp, async (_event, payload: unknown) => {
    const parsed = credentialsSchema.safeParse(payload);
    const result = parsed.success
      ? await auth.signUp(parsed.data)
      : INVALID_CREDENTIALS_RESULT;
    return outbound(
      IpcChannel.authSignUp,
      authResultMessageSchema,
      result,
      OFF_CONTRACT_AUTH_RESULT,
    );
  });

  ipcMain.handle(IpcChannel.authSignOut, async () =>
    outbound(
      IpcChannel.authSignOut,
      authResultMessageSchema,
      await auth.signOut(),
      OFF_CONTRACT_AUTH_RESULT,
    ),
  );

  ipcMain.handle(IpcChannel.apiGetMe, async () =>
    outbound(
      IpcChannel.apiGetMe,
      meResultMessageSchema,
      await api.getMe(),
      OFF_CONTRACT_ME_RESULT,
    ),
  );

  const unsubscribe = auth.subscribe((state) => {
    const parsed = authStateMessageSchema.safeParse(state);
    if (!parsed.success) {
      // Skipped rather than substituted: a push is unsolicited, and telling
      // every window the session is `unavailable` because WE mis-shaped a
      // message would sign the user out of a session that is still good.
      reportOffContract(IpcChannel.authStateChanged, parsed.error);
      return;
    }
    // Broadcast rather than tracked per window: this app has one window today
    // and gains an overlay in chunk 4, and both want the same answer.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.authStateChanged, parsed.data);
      }
    }
  });

  return () => {
    unsubscribe();
    for (const channel of [
      IpcChannel.authGetState,
      IpcChannel.authSignIn,
      IpcChannel.authSignUp,
      IpcChannel.authSignOut,
      IpcChannel.apiGetMe,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}

/**
 * The fallback for a state we could not serialise. `unavailable` is the branch
 * that stops and explains itself rather than offering a sign-in that may not
 * work — the same choice the preload makes for the same reason.
 */
function unreadableState(): AuthStateMessage {
  return { status: "unavailable", message: INVALID_BRIDGE_RESPONSE_MESSAGE };
}
