import { BrowserWindow, ipcMain } from "electron";
import type { z } from "zod";

import type { ApiClient } from "../api/client";
import type { AuthActionResult } from "../auth/errors";
import type { AuthService } from "../auth/service";
import type { LiveSessionService } from "../live/session";
import type { ScreenPrivacyService } from "../privacy/screen-privacy";
import { IpcChannel } from "./channels";
import {
  authResultMessageSchema,
  authStateMessageSchema,
  credentialsSchema,
  liveActionResultSchema,
  liveAskMessageSchema,
  livePausedMessageSchema,
  liveSessionEventSchema,
  liveStartMessageSchema,
  meResultMessageSchema,
  pillClickThroughMessageSchema,
  pillResizeMessageSchema,
  privacyStateMessageSchema,
  INVALID_BRIDGE_RESPONSE_MESSAGE,
  INVALID_CREDENTIALS_PAYLOAD_MESSAGE,
  type AuthStateMessage,
  type LiveActionResult,
  type LiveSessionEvent,
  type MeResultMessage,
  type PrivacyStateMessage,
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
  privacy: ScreenPrivacyService;
  /** The live-call orchestrator (start/stop/pause); its events arrive via
   * {@link pushLiveEvent}, which main wires as the service's emit. */
  live: LiveSessionService;
  /** Open (or focus) the settings window. Injected so this file stays wiring. */
  openSettings: () => void;
  /** Resize the pill window to its content height, already bounds-checked. */
  resizePill: (height: number) => void;
  /** Let clicks fall through the pill window's invisible gutters (or stop). */
  setPillClickThrough: (clickThrough: boolean) => void;
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

const OFF_CONTRACT_LIVE_RESULT: LiveActionResult = {
  ok: false,
  message: INVALID_BRIDGE_RESPONSE_MESSAGE,
};

/**
 * The safe direction when a privacy answer cannot be shaped: report
 * DETECTABLE. A user who wrongly believes they are visible double-checks; a
 * user who wrongly believes they are hidden shares their copilot with a
 * prospect.
 */
const DETECTABLE_FALLBACK: PrivacyStateMessage = { enabled: false };

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

/** Broadcast one payload to every live window — the pattern every push uses. */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

/**
 * The live session's emit sink: contract-checked, then broadcast. Exported so
 * the composition root can hand it to the service at construction — the
 * service and this file never import each other's internals.
 */
export function pushLiveEvent(event: LiveSessionEvent): void {
  const parsed = liveSessionEventSchema.safeParse(event);
  if (!parsed.success) {
    // Skipped rather than substituted: a mis-shaped transcript line is our
    // bug, and inventing a replacement would put words on the user's screen.
    reportOffContract(IpcChannel.liveEvent, parsed.error);
    return;
  }
  broadcast(IpcChannel.liveEvent, parsed.data);
}

/** Registers every handler and the auth push. Returns its own teardown. */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const {
    auth,
    api,
    privacy,
    live,
    openSettings,
    resizePill,
    setPillClickThrough,
  } = deps;

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

  ipcMain.handle(IpcChannel.privacyGetState, () =>
    outbound(
      IpcChannel.privacyGetState,
      privacyStateMessageSchema,
      { enabled: privacy.get() },
      DETECTABLE_FALLBACK,
    ),
  );

  ipcMain.handle(IpcChannel.privacySetState, (_event, payload: unknown) => {
    const parsed = privacyStateMessageSchema.safeParse(payload);
    // A payload that does not parse changes NOTHING — the current state is
    // returned so the asking UI snaps back to reality instead of latching a
    // toggle the OS never saw.
    const enabled = parsed.success
      ? privacy.set(parsed.data.enabled)
      : privacy.get();
    const state = outbound(
      IpcChannel.privacySetState,
      privacyStateMessageSchema,
      { enabled },
      DETECTABLE_FALLBACK,
    );
    // Every window hears about it, including the one that asked — the pill's
    // eye and the settings toggle must never disagree about whether the user
    // is visible in a share.
    broadcast(IpcChannel.privacyStateChanged, state);
    return state;
  });

  ipcMain.handle(IpcChannel.liveStart, async (_event, payload: unknown) => {
    const parsed = liveStartMessageSchema.safeParse(payload);
    const result: LiveActionResult = parsed.success
      ? await live.start(parsed.data.mode, parsed.data.model ?? "gpt")
      : { ok: false, message: "That is not a mode this build knows." };
    return outbound(
      IpcChannel.liveStart,
      liveActionResultSchema,
      result,
      OFF_CONTRACT_LIVE_RESULT,
    );
  });

  ipcMain.handle(IpcChannel.liveStop, () => {
    live.stop();
    return outbound(
      IpcChannel.liveStop,
      liveActionResultSchema,
      { ok: true },
      OFF_CONTRACT_LIVE_RESULT,
    );
  });

  ipcMain.handle(IpcChannel.liveAsk, (_event, payload: unknown) => {
    const parsed = liveAskMessageSchema.safeParse(payload);
    const result: LiveActionResult = parsed.success
      ? live.ask(parsed.data.text)
      : { ok: false, message: "That is not an ask this build knows." };
    return outbound(
      IpcChannel.liveAsk,
      liveActionResultSchema,
      result,
      OFF_CONTRACT_LIVE_RESULT,
    );
  });

  const onLiveSetPaused = (_event: unknown, payload: unknown): void => {
    const parsed = livePausedMessageSchema.safeParse(payload);
    if (!parsed.success) {
      // Dropped: a garbled payload must not decide whether a call records.
      reportOffContract(IpcChannel.liveSetPaused, parsed.error);
      return;
    }
    live.setPaused(parsed.data.paused);
  };
  ipcMain.on(IpcChannel.liveSetPaused, onLiveSetPaused);

  const onSettingsOpen = (): void => {
    openSettings();
  };
  ipcMain.on(IpcChannel.settingsOpen, onSettingsOpen);

  const onPillResize = (_event: unknown, payload: unknown): void => {
    const parsed = pillResizeMessageSchema.safeParse(payload);
    if (!parsed.success) {
      // Dropped, not clamped: this number becomes OS window geometry, and a
      // renderer sending garbage geometry is a bug to surface, not smooth over.
      reportOffContract(IpcChannel.pillResize, parsed.error);
      return;
    }
    resizePill(parsed.data.height);
  };
  ipcMain.on(IpcChannel.pillResize, onPillResize);

  const onPillClickThrough = (_event: unknown, payload: unknown): void => {
    const parsed = pillClickThroughMessageSchema.safeParse(payload);
    if (!parsed.success) {
      // Dropped: a garbled payload must not decide whether the window takes
      // clicks — the pointer's next move over a valid region re-sends it.
      reportOffContract(IpcChannel.pillClickThrough, parsed.error);
      return;
    }
    setPillClickThrough(parsed.data.clickThrough);
  };
  ipcMain.on(IpcChannel.pillClickThrough, onPillClickThrough);

  const unsubscribe = auth.subscribe((state) => {
    const parsed = authStateMessageSchema.safeParse(state);
    if (!parsed.success) {
      // Skipped rather than substituted: a push is unsolicited, and telling
      // every window the session is `unavailable` because WE mis-shaped a
      // message would sign the user out of a session that is still good.
      reportOffContract(IpcChannel.authStateChanged, parsed.error);
      return;
    }
    // Broadcast rather than tracked per window: every window wants the same
    // answer.
    broadcast(IpcChannel.authStateChanged, parsed.data);
  });

  return () => {
    unsubscribe();
    ipcMain.removeListener(IpcChannel.settingsOpen, onSettingsOpen);
    ipcMain.removeListener(IpcChannel.pillResize, onPillResize);
    ipcMain.removeListener(IpcChannel.pillClickThrough, onPillClickThrough);
    ipcMain.removeListener(IpcChannel.liveSetPaused, onLiveSetPaused);
    for (const channel of [
      IpcChannel.authGetState,
      IpcChannel.authSignIn,
      IpcChannel.authSignUp,
      IpcChannel.authSignOut,
      IpcChannel.apiGetMe,
      IpcChannel.privacyGetState,
      IpcChannel.privacySetState,
      IpcChannel.liveStart,
      IpcChannel.liveStop,
      IpcChannel.liveAsk,
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
