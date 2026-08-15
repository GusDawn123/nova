import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/service";
import type { AuthState } from "../auth/state";

/**
 * These handlers are wiring, so the tests are about the wiring's failure modes
 * rather than about auth or HTTP — both of which are already covered where the
 * decisions actually live.
 *
 * The case that matters most: an `ipcMain.handle` callback that THROWS turns
 * into a rejected `invoke` in the renderer, which arrives as a stringified
 * stack trace and leaves whatever in-flight flag the caller set latched on. The
 * whole contract is built on these calls resolving with a typed result, so a
 * handler that can throw quietly deletes the failure path both sides were
 * written for.
 */

/** The registry `ipcMain.handle` writes into, so a test can invoke a channel. */
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
/** Same idea for the one-way `ipcMain.on` channels, so a test can send. */
const listeners = new Map<
  string,
  (event: unknown, ...args: unknown[]) => void
>();
const removedChannels: string[] = [];
const sentToWindows: { channel: string; payload: unknown }[] = [];
let windows: {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, payload: unknown) => void };
}[] = [];

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      removedChannels.push(channel);
      handlers.delete(channel);
    },
    on: (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void,
    ) => {
      listeners.set(channel, listener);
    },
    removeListener: (channel: string) => {
      listeners.delete(channel);
    },
  },
  BrowserWindow: {
    getAllWindows: () => windows,
  },
}));

const { registerIpcHandlers } = await import("./handlers");
const { IpcChannel } = await import("./channels");
const { INVALID_BRIDGE_RESPONSE_MESSAGE } = await import("./contract");

const USER_ID = "11111111-1111-4111-8111-111111111111";

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`no handler registered for ${channel}`);
  }
  return Promise.resolve(handler({}, ...args));
}

/** Fire a one-way channel the way `ipcRenderer.send` would. */
function send(channel: string, ...args: unknown[]): void {
  const listener = listeners.get(channel);
  if (listener === undefined) {
    throw new Error(`no listener registered for ${channel}`);
  }
  listener({}, ...args);
}

interface Stubs {
  signIn: ReturnType<typeof vi.fn>;
  signUp: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
  privacySet: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
  resizePill: ReturnType<typeof vi.fn>;
  emit: (state: unknown) => void;
  dispose: () => void;
}

function register(overrides: Partial<AuthService> = {}): Stubs {
  const signIn = vi.fn().mockResolvedValue({ ok: true });
  const signUp = vi.fn().mockResolvedValue({ ok: true });
  const getMe = vi
    .fn()
    .mockResolvedValue({ ok: true, data: { user_id: USER_ID } });
  let listener: ((state: AuthState) => void) | null = null;

  const auth: AuthService = {
    getState: () => ({ status: "signed-out" }),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    signIn,
    signUp,
    signOut: vi.fn().mockResolvedValue({ ok: true }),
    getAccessToken: vi.fn().mockResolvedValue(null),
    dispose: vi.fn(),
    ...overrides,
  };

  // A real-enough privacy stub: set() latches, get() reads back — the handler
  // tests care that the wiring calls it and echoes what it returned.
  let privacyEnabled = false;
  const privacySet = vi.fn((enabled: boolean) => {
    privacyEnabled = enabled;
    return privacyEnabled;
  });
  const openSettings = vi.fn();
  const resizePill = vi.fn();

  const dispose = registerIpcHandlers({
    auth,
    api: { getMe },
    privacy: {
      attach: vi.fn(),
      set: privacySet,
      get: () => privacyEnabled,
    },
    openSettings,
    resizePill,
  });

  return {
    signIn,
    signUp,
    getMe,
    privacySet,
    openSettings,
    resizePill,
    dispose,
    emit: (state) => {
      // Cast because one test pushes a state the contract forbids, which is
      // the only way to reach the broadcast guard — the typed interface makes
      // that value unconstructable by design.
      listener?.(state as AuthState);
    },
  };
}

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  removedChannels.length = 0;
  sentToWindows.length = 0;
  windows = [];
  vi.restoreAllMocks();
});

describe("credentials arriving from the renderer", () => {
  it("rejects a malformed payload without reaching the auth service", async () => {
    const { signIn } = register();

    const result = await invoke(IpcChannel.authSignIn, { email: "nope" });

    expect(signIn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, kind: "invalid-request" });
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an extra key", { email: "a@b.co", password: "x", admin: true }],
  ])("rejects %s", async (_label, payload) => {
    const { signIn } = register();

    expect(await invoke(IpcChannel.authSignIn, payload)).toMatchObject({
      ok: false,
      kind: "invalid-request",
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("forwards a valid payload and returns what the service said", async () => {
    const { signUp } = register();

    const result = await invoke(IpcChannel.authSignUp, {
      email: "dev@nova.test",
      password: "nova-dev-1234",
    });

    expect(signUp).toHaveBeenCalledWith({
      email: "dev@nova.test",
      password: "nova-dev-1234",
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("a result that does not match the contract", () => {
  it("resolves with a typed failure instead of rejecting", async () => {
    // The regression this file exists for. An outbound `.parse()` would throw
    // here, `invoke` would reject, and the renderer would get a stack trace
    // where it was promised a result it could render.
    const { getMe } = register();
    getMe.mockResolvedValue({ ok: false, kind: "wizard", message: "???" });

    const result = await invoke(IpcChannel.apiGetMe);

    expect(result).toEqual({
      ok: false,
      kind: "schema",
      message: INVALID_BRIDGE_RESPONSE_MESSAGE,
    });
  });

  it("does the same for an auth action", async () => {
    const { signIn } = register();
    signIn.mockResolvedValue({ ok: false, kind: "not-a-kind", message: "x" });

    expect(
      await invoke(IpcChannel.authSignIn, {
        email: "dev@nova.test",
        password: "nova-dev-1234",
      }),
    ).toMatchObject({ ok: false, kind: "unknown" });
  });

  it("answers an unreadable state with unavailable, never a guess", async () => {
    // The one cast in this file, and the test's whole subject: a state the
    // contract does not allow cannot be produced through the typed interface,
    // so the only way to exercise the guard is to reach past it.
    register({ getState: () => ({ status: "vibes" }) as unknown as AuthState });

    expect(await invoke(IpcChannel.authGetState)).toEqual({
      status: "unavailable",
      message: INVALID_BRIDGE_RESPONSE_MESSAGE,
    });
  });
});

describe("the auth state push", () => {
  function windowStub(destroyed: boolean) {
    return {
      isDestroyed: () => destroyed,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sentToWindows.push({ channel, payload });
        },
      },
    };
  }

  it("reaches every live window and skips destroyed ones", () => {
    const live = windowStub(false);
    windows = [live, windowStub(true)];
    const { emit } = register();

    emit({ status: "signed-in", user: { id: USER_ID } });

    expect(sentToWindows).toEqual([
      {
        channel: IpcChannel.authStateChanged,
        payload: { status: "signed-in", user: { id: USER_ID } },
      },
    ]);
  });

  it("drops an off-contract push rather than broadcasting a wrong state", () => {
    // Skipped, NOT substituted with `unavailable`: a push is unsolicited, and
    // telling every window the session is gone because WE mis-shaped a message
    // would sign the user out of a session that is still perfectly good.
    windows = [windowStub(false)];
    const { emit } = register();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    emit({ status: "signed-in" });

    expect(sentToWindows).toEqual([]);
  });
});

describe("the undetectability toggle", () => {
  function windowStub() {
    return {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sentToWindows.push({ channel, payload });
        },
      },
    };
  }

  it("answers get-state from the service", async () => {
    register();

    expect(await invoke(IpcChannel.privacyGetState)).toEqual({
      enabled: false,
    });
  });

  it("applies a valid change, broadcasts it, and echoes the new state", async () => {
    windows = [windowStub(), windowStub()];
    const { privacySet } = register();

    const result = await invoke(IpcChannel.privacySetState, { enabled: true });

    expect(privacySet).toHaveBeenCalledTimes(1);
    expect(privacySet).toHaveBeenCalledWith(true);
    expect(result).toEqual({ enabled: true });
    // Both windows hear it — the pill's eye and the settings toggle must never
    // disagree about whether the user is visible in a share.
    expect(sentToWindows).toEqual([
      { channel: IpcChannel.privacyStateChanged, payload: { enabled: true } },
      { channel: IpcChannel.privacyStateChanged, payload: { enabled: true } },
    ]);
  });

  it.each([
    ["a bare boolean", true],
    ["an extra key", { enabled: true, mode: "extra" }],
    ["a stringy boolean", { enabled: "true" }],
  ])("leaves the state alone when sent %s", async (_label, payload) => {
    const { privacySet } = register();

    const result = await invoke(IpcChannel.privacySetState, payload);

    expect(privacySet).not.toHaveBeenCalled();
    // The asking UI snaps back to reality instead of latching a toggle the OS
    // never saw.
    expect(result).toEqual({ enabled: false });
  });
});

describe("one-way window management", () => {
  it("opens the settings window on request", () => {
    const { openSettings } = register();

    send(IpcChannel.settingsOpen);

    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("resizes the pill to a sane height", () => {
    const { resizePill } = register();

    send(IpcChannel.pillResize, { height: 480 });

    expect(resizePill).toHaveBeenCalledTimes(1);
    expect(resizePill).toHaveBeenCalledWith(480);
  });

  it.each([
    ["a zero height", { height: 0 }],
    ["a screen-swallowing height", { height: 99999 }],
    ["a fractional height", { height: 120.5 }],
    ["no payload at all", undefined],
  ])("drops %s instead of resizing", (_label, payload) => {
    const { resizePill } = register();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    send(IpcChannel.pillResize, payload);

    expect(resizePill).not.toHaveBeenCalled();
  });
});

describe("teardown", () => {
  it("removes every channel it registered", () => {
    const { dispose } = register();
    const registered = [...handlers.keys()];

    dispose();

    // Seven request/response channels. Leaving one behind would make a second
    // `registerIpcHandlers` throw on a duplicate handler, which is exactly what
    // a window reopening on macOS would do.
    expect(registered).toHaveLength(7);
    // Copied before sorting — `toSorted` is ES2023 and the lib target is ES2022.
    expect([...removedChannels].sort()).toEqual([...registered].sort());
    expect(handlers.size).toBe(0);
    // The one-way listeners go with them.
    expect(listeners.size).toBe(0);
  });

  it("stops pushing state after teardown", () => {
    windows = [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sentToWindows.push({ channel, payload });
          },
        },
      },
    ];
    const { dispose, emit } = register();

    dispose();
    emit({ status: "signed-out" });

    expect(sentToWindows).toEqual([]);
  });
});
