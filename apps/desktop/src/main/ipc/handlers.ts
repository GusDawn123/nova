import { BrowserWindow, ipcMain } from "electron";

import type { ApiClient } from "../api/client";
import type { AuthActionResult } from "../auth/errors";
import type { AuthService } from "../auth/service";
import { IpcChannel } from "./channels";
import {
  credentialsSchema,
  meResultMessageSchema,
  authResultMessageSchema,
  authStateMessageSchema,
  INVALID_CREDENTIALS_PAYLOAD_MESSAGE,
} from "./contract";

/**
 * Wiring only. Every decision lives in the auth service or the api client; this
 * file connects them to channels and checks what crosses.
 *
 * On direction: renderer → main is parsed because the renderer is the process
 * that loads untrusted content, and `contextIsolation` stops it reaching into
 * main without making anything it SENDS trustworthy. main → renderer is parsed
 * too, on the way out, which is a different bet — not about trust but about
 * catching our own wiring mistakes at the boundary where they were made rather
 * than as an undefined field three layers into the UI.
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

/** Registers every handler and the auth push. Returns its own teardown. */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const { auth, api } = deps;

  ipcMain.handle(IpcChannel.authGetState, () =>
    authStateMessageSchema.parse(auth.getState()),
  );

  ipcMain.handle(IpcChannel.authSignIn, async (_event, payload: unknown) => {
    const parsed = credentialsSchema.safeParse(payload);
    // Answered in the action's own vocabulary rather than by throwing: `invoke`
    // turns a thrown error into a rejected promise carrying a stringified
    // stack, which is both a worse experience and more than the renderer needs.
    const result = parsed.success
      ? await auth.signIn(parsed.data)
      : INVALID_CREDENTIALS_RESULT;
    return authResultMessageSchema.parse(result);
  });

  ipcMain.handle(IpcChannel.authSignUp, async (_event, payload: unknown) => {
    const parsed = credentialsSchema.safeParse(payload);
    const result = parsed.success
      ? await auth.signUp(parsed.data)
      : INVALID_CREDENTIALS_RESULT;
    return authResultMessageSchema.parse(result);
  });

  ipcMain.handle(IpcChannel.authSignOut, async () =>
    authResultMessageSchema.parse(await auth.signOut()),
  );

  ipcMain.handle(IpcChannel.apiGetMe, async () =>
    meResultMessageSchema.parse(await api.getMe()),
  );

  const unsubscribe = auth.subscribe((state) => {
    const message = authStateMessageSchema.parse(state);
    // Broadcast rather than tracked per window: this app has one window today
    // and will have an overlay beside it in chunk 4, and both want the same
    // answer. `getAllWindows` is already the live set, so a window closed
    // between the change firing and this loop is simply not in it.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.authStateChanged, message);
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
