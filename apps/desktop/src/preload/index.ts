import { contextBridge, ipcRenderer } from "electron";

import type { AuthActionResult } from "../main/auth/errors";
import type { AuthState } from "../main/auth/state";
import { IpcChannel } from "../main/ipc/channels";
import {
  authResultMessageSchema,
  authStateMessageSchema,
  meResultMessageSchema,
  INVALID_BRIDGE_RESPONSE_MESSAGE,
  type MeResultMessage,
} from "../main/ipc/contract";

/**
 * Everything the renderer is allowed to reach, in one namespaced object.
 * `contextIsolation` means nothing else crosses from the main process, so this
 * type is the complete privilege surface of the UI — keep it that way.
 *
 * Note what is NOT here: no access token, no Supabase client, no `fetch` to an
 * arbitrary URL. The renderer can ask for an identity and it can ask main to
 * make one specific authed call; it can never hold a credential. Six members,
 * and adding a seventh should feel like a decision.
 *
 * These imports reach into `../main/` for the channel names and the schemas
 * only. The preload is bundled separately, so nothing but those constants
 * travels with them — and sharing them is the point, since a preload that
 * restated the channel strings would drift from the handlers silently.
 */
export interface NovaBridge {
  readonly signIn: (
    email: string,
    password: string,
  ) => Promise<AuthActionResult>;
  readonly signUp: (
    email: string,
    password: string,
  ) => Promise<AuthActionResult>;
  readonly signOut: () => Promise<AuthActionResult>;
  readonly getAuthState: () => Promise<AuthState>;
  /** Subscribe to main's auth pushes. Returns its own unsubscribe. */
  readonly onAuthStateChange: (
    listener: (state: AuthState) => void,
  ) => () => void;
  readonly getMe: () => Promise<MeResultMessage>;
}

/**
 * `ipcRenderer.invoke` is typed `Promise<any>`, so every answer is parsed rather
 * than cast. That satisfies the house rule (parse every boundary) and the
 * linter's no-unsafe-return in the same move — a cast would have needed a `why:`
 * comment and still been a lie.
 *
 * A payload that fails to parse is a wiring bug in OUR code, not a user error,
 * but it still may not throw: these results are rendered, and an exception
 * crossing IPC arrives in the UI as a stringified stack. So it degrades to the
 * same typed failure everything else uses.
 */
async function invokeAuthAction(
  channel: string,
  ...args: unknown[]
): Promise<AuthActionResult> {
  const raw: unknown = await ipcRenderer.invoke(channel, ...args);
  const parsed = authResultMessageSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  return {
    ok: false,
    kind: "unknown",
    message: INVALID_BRIDGE_RESPONSE_MESSAGE,
  };
}

const novaBridge: NovaBridge = {
  signIn: (email, password) =>
    invokeAuthAction(IpcChannel.authSignIn, { email, password }),
  signUp: (email, password) =>
    invokeAuthAction(IpcChannel.authSignUp, { email, password }),
  signOut: () => invokeAuthAction(IpcChannel.authSignOut),

  getAuthState: async () => {
    const raw: unknown = await ipcRenderer.invoke(IpcChannel.authGetState);
    const parsed = authStateMessageSchema.safeParse(raw);
    // A state we cannot read is not a state we may guess at. `unavailable` is
    // the branch that stops and explains itself rather than offering a sign-in.
    return parsed.success
      ? parsed.data
      : { status: "unavailable", message: INVALID_BRIDGE_RESPONSE_MESSAGE };
  },

  onAuthStateChange: (listener) => {
    // The raw IpcRendererEvent carries `sender`, a live handle to the main
    // process's side of the channel. It stops here; only the payload goes on.
    const forward = (_event: unknown, raw: unknown): void => {
      const parsed = authStateMessageSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on(IpcChannel.authStateChanged, forward);
    // Returned rather than assumed: React's effect cleanup calls this on every
    // re-run, and without it a hot reload would stack a second listener onto the
    // same channel and deliver every push twice.
    return () => {
      ipcRenderer.removeListener(IpcChannel.authStateChanged, forward);
    };
  },

  getMe: async () => {
    const raw: unknown = await ipcRenderer.invoke(IpcChannel.apiGetMe);
    const parsed = meResultMessageSchema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : { ok: false, kind: "schema", message: INVALID_BRIDGE_RESPONSE_MESSAGE };
  },
};

contextBridge.exposeInMainWorld("novaBridge", novaBridge);
