import { contextBridge, ipcRenderer } from "electron";

import type { AuthActionResult } from "../main/auth/errors";
import type { AuthState } from "../main/auth/state";
import { IpcChannel, type IpcChannelName } from "../main/ipc/channels";
import {
  authResultMessageSchema,
  authStateMessageSchema,
  liveActionResultSchema,
  liveSessionEventSchema,
  meResultMessageSchema,
  privacyStateMessageSchema,
  INVALID_BRIDGE_RESPONSE_MESSAGE,
  type LiveActionResult,
  type LiveSessionEvent,
  type MeResultMessage,
  type PrivacyStateMessage,
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
  /**
   * Undetectability. The renderer only ever ASKS — the flag itself is a
   * main-process act on the windows (docs/DESIGN/desktop-screen-privacy-notes.md),
   * and every answer here is what main reports back, not what the UI wished.
   */
  readonly getScreenPrivacy: () => Promise<PrivacyStateMessage>;
  readonly setScreenPrivacy: (enabled: boolean) => Promise<PrivacyStateMessage>;
  readonly onScreenPrivacyChange: (
    listener: (state: PrivacyStateMessage) => void,
  ) => () => void;
  /**
   * The live call. Start/stop are asks — main owns the session, the engine,
   * and the socket; the renderer only ever hears what happened via
   * `onLiveEvent`. `mode` is a plain string here so the UI's menu ids pass
   * through; main validates it against the shared protocol's mode vocabulary.
   */
  readonly startLiveSession: (mode: string) => Promise<LiveActionResult>;
  readonly stopLiveSession: () => Promise<LiveActionResult>;
  readonly setLiveSessionPaused: (paused: boolean) => void;
  readonly onLiveEvent: (
    listener: (event: LiveSessionEvent) => void,
  ) => () => void;
  /** Ask main to open (or focus) the settings window. Fire-and-forget. */
  readonly openSettings: () => void;
  /** Tell main the pill's content height so the window can hug it. */
  readonly resizePill: (height: number) => void;
  /**
   * Let clicks pass through the pill window's invisible gutters (or take them
   * again). Sent as the pointer crosses between content and empty space.
   */
  readonly setPillClickThrough: (clickThrough: boolean) => void;
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
async function invoke(
  channel: IpcChannelName,
  ...args: unknown[]
): Promise<unknown> {
  // `ipcRenderer.invoke` REJECTS whenever the main handler throws, and a
  // rejection here surfaces in the UI as a stringified stack trace while
  // leaving whichever in-flight flag the caller set latched on. The renderer is
  // written on the promise that these calls always resolve; this is where that
  // promise is kept, so `undefined` falls through to the same off-contract path
  // as a mis-shaped payload.
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error: unknown) {
    console.error(`[bridge] ${channel} did not answer`, error);
    return undefined;
  }
}

async function invokeAuthAction(
  channel: IpcChannelName,
  ...args: unknown[]
): Promise<AuthActionResult> {
  const parsed = authResultMessageSchema.safeParse(
    await invoke(channel, ...args),
  );
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
    const parsed = authStateMessageSchema.safeParse(
      await invoke(IpcChannel.authGetState),
    );
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
    const parsed = meResultMessageSchema.safeParse(
      await invoke(IpcChannel.apiGetMe),
    );
    return parsed.success
      ? parsed.data
      : { ok: false, kind: "schema", message: INVALID_BRIDGE_RESPONSE_MESSAGE };
  },

  getScreenPrivacy: async () => {
    const parsed = privacyStateMessageSchema.safeParse(
      await invoke(IpcChannel.privacyGetState),
    );
    // An unreadable answer reports DETECTABLE — the direction where a wrong
    // belief makes the user double-check, not overshare.
    return parsed.success ? parsed.data : { enabled: false };
  },

  setScreenPrivacy: async (enabled) => {
    const parsed = privacyStateMessageSchema.safeParse(
      await invoke(IpcChannel.privacySetState, { enabled }),
    );
    return parsed.success ? parsed.data : { enabled: false };
  },

  onScreenPrivacyChange: (listener) => {
    const forward = (_event: unknown, raw: unknown): void => {
      const parsed = privacyStateMessageSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on(IpcChannel.privacyStateChanged, forward);
    return () => {
      ipcRenderer.removeListener(IpcChannel.privacyStateChanged, forward);
    };
  },

  startLiveSession: async (mode) => {
    const parsed = liveActionResultSchema.safeParse(
      await invoke(IpcChannel.liveStart, { mode }),
    );
    return parsed.success
      ? parsed.data
      : { ok: false, message: INVALID_BRIDGE_RESPONSE_MESSAGE };
  },

  stopLiveSession: async () => {
    const parsed = liveActionResultSchema.safeParse(
      await invoke(IpcChannel.liveStop),
    );
    return parsed.success
      ? parsed.data
      : { ok: false, message: INVALID_BRIDGE_RESPONSE_MESSAGE };
  },

  setLiveSessionPaused: (paused) => {
    ipcRenderer.send(IpcChannel.liveSetPaused, { paused });
  },

  onLiveEvent: (listener) => {
    const forward = (_event: unknown, raw: unknown): void => {
      const parsed = liveSessionEventSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on(IpcChannel.liveEvent, forward);
    return () => {
      ipcRenderer.removeListener(IpcChannel.liveEvent, forward);
    };
  },

  openSettings: () => {
    ipcRenderer.send(IpcChannel.settingsOpen);
  },

  resizePill: (height) => {
    ipcRenderer.send(IpcChannel.pillResize, { height });
  },

  setPillClickThrough: (clickThrough) => {
    ipcRenderer.send(IpcChannel.pillClickThrough, { clickThrough });
  },
};

contextBridge.exposeInMainWorld("novaBridge", novaBridge);
