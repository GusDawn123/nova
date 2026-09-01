import { join } from "node:path";

import { BrowserWindow, globalShortcut, screen } from "electron";

import type { ScreenPrivacyService } from "../privacy/screen-privacy";
import { hardenNavigation, loadRendererPage } from "./navigation";
import {
  moveWindowBy,
  resizeWindowTo,
  type MoveDirection,
  type PillSize,
} from "./pill-move";

/**
 * How long the pill is: a fraction of the screen's width, per Gustavo's
 * 2026-08-15 sizing pass ("a bit bigger than 1/3"). The pill's INTERNAL sizes —
 * row thickness, fonts, icons — never change; the shell just stretches to
 * fill whatever window this hands it (`.pill-stage` is 100vw), so this
 * constant is the one knob for the pill's length.
 */
const PILL_SCREEN_FRACTION = 0.36;

/**
 * The window is wider than the pill so the CSS drop shadow has somewhere to
 * land — a transparent window clips at its own bounds, and a shadow cut off in
 * a hard rectangle reads as a rendering bug. Must equal the `.pill-stage`
 * side padding in pill.css (40px each side).
 */
const SHADOW_GUTTERS = 80;
const INITIAL_HEIGHT = 160;
const TOP_MARGIN = 12;

let pillWindow: BrowserWindow | null = null;
/**
 * The pill's canonical size in DIPs — the ONE source of truth for how big the
 * window is. Every size write re-asserts it; no size is ever read back from
 * the OS (on scaled displays readback is lossy and a read-modify-write grows
 * the window a pixel per round trip — the 2026-08-19 growth bug).
 */
let pillSize: PillSize | null = null;

/**
 * The pill — Nova's face. Frameless, transparent, always on top, and attached
 * to the screen-privacy service at birth so it is born wearing the current
 * capture-exclusion state rather than flashing into a share and ducking.
 */
export async function createPillWindow(
  privacy: ScreenPrivacyService,
): Promise<BrowserWindow> {
  // Idempotent: auth pushes signed-in on every token refresh, and each of
  // those must not stack another pill on screen.
  if (pillWindow !== null && !pillWindow.isDestroyed()) {
    return pillWindow;
  }

  const { workArea } = screen.getPrimaryDisplay();
  const windowWidth =
    Math.round(workArea.width * PILL_SCREEN_FRACTION) + SHADOW_GUTTERS;

  const window = new BrowserWindow({
    width: windowWidth,
    height: INITIAL_HEIGHT,
    x: workArea.x + Math.round((workArea.width - windowWidth) / 2),
    y: workArea.y + TOP_MARGIN,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    // An overlay, not an app window: it lives above the meeting, not in the
    // task switcher next to it.
    skipTaskbar: true,
    title: "Nova",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  privacy.attach(window);
  // 'screen-saver' is the level that stays above a fullscreen meeting app —
  // plain alwaysOnTop loses that fight on Windows.
  window.setAlwaysOnTop(true, "screen-saver");

  window.on("ready-to-show", () => {
    window.show();
  });
  // Move-the-pill hotkeys (Ctrl+Arrows — Gustavo's 2026-08-19 pick, matching
  // the reference app's muscle memory). Global by necessity: the pill is an
  // overlay that is almost never the focused window. Scoped to visibility so
  // the theft of Ctrl+Left/Right (word-jump in every text field) lasts only
  // while the pill is actually on screen — hidden or closed, typing gets its
  // keys back. ONLY the pill moves; the settings window never registers these.
  window.on("show", registerMoveShortcuts);
  window.on("hide", unregisterMoveShortcuts);
  window.on("closed", () => {
    pillWindow = null;
    pillSize = null;
    stopIgnoreHeartbeat();
    unregisterMoveShortcuts();
  });
  // EVERY page load starts clickable — a reloading renderer must never
  // inherit an ignore state it no longer knows about (dev reloads mid-hover;
  // pairs with the renderer's own mount-time reset).
  window.webContents.on("did-finish-load", () => {
    setPillClickThrough(false);
  });

  hardenNavigation(window);
  // Assigned before the page loads so a second call during the load returns
  // this window instead of building another one.
  pillWindow = window;
  pillSize = { width: windowWidth, height: INITIAL_HEIGHT };
  try {
    await loadRendererPage(window, "pill.html");
  } catch (error) {
    // A window that failed to load must not stay latched as "the pill" — the
    // next create would return a blank shell forever.
    pillWindow = null;
    if (!window.isDestroyed()) {
      window.destroy();
    }
    throw error;
  }

  return window;
}

export function closePillWindow(): void {
  if (pillWindow !== null && !pillWindow.isDestroyed()) {
    pillWindow.close();
  }
}

/** Accelerator → direction for the pill-mover (all four register together). */
const MOVE_ACCELERATORS: Record<string, MoveDirection> = {
  "CommandOrControl+Up": "up",
  "CommandOrControl+Down": "down",
  "CommandOrControl+Left": "left",
  "CommandOrControl+Right": "right",
};

/**
 * Nudge the pill one step, clamped into the work area of whichever display
 * the nudged rectangle lands on — free to cross onto a second monitor, never
 * able to strand off-screen.
 */
function movePill(direction: MoveDirection): void {
  if (
    pillWindow === null ||
    pillWindow.isDestroyed() ||
    !pillWindow.isVisible()
  ) {
    return;
  }
  if (pillSize === null) {
    return;
  }
  const size = pillSize;
  // TEMP DEBUG (2026-08-19 growth bug): remove once the mover is proven.
  console.log(
    `[pill-move] dir=${direction} canonical=${JSON.stringify(size)} before=${JSON.stringify(pillWindow.getBounds())}`,
  );
  moveWindowBy(
    pillWindow,
    size,
    direction,
    (rect) => screen.getDisplayMatching(rect).workArea,
  );
  // TEMP DEBUG (2026-08-19 growth bug): remove once the mover is proven.
  console.log(`[pill-move] after=${JSON.stringify(pillWindow.getBounds())}`);
}

function registerMoveShortcuts(): void {
  for (const [accelerator, direction] of Object.entries(MOVE_ACCELERATORS)) {
    globalShortcut.register(accelerator, () => {
      movePill(direction);
    });
  }
}

function unregisterMoveShortcuts(): void {
  for (const accelerator of Object.keys(MOVE_ACCELERATORS)) {
    globalShortcut.unregister(accelerator);
  }
}

/**
 * Size the window to the pill's content. The pill grows downward (history,
 * transcript, the mode menu), so width and position stay put and only the
 * height follows. Height is already bounds-checked at the IPC boundary.
 */
export function resizePillWindow(height: number): void {
  if (pillWindow === null || pillWindow.isDestroyed()) {
    return;
  }
  if (pillSize === null) {
    return;
  }
  // Width comes from the CANONICAL size, never from getBounds() readback —
  // sourcing it from readback gained a pixel per call on scaled displays
  // (the 2026-08-19 growth bug; see pill-move.ts).
  pillSize = resizeWindowTo(pillWindow, pillSize, height);
  // TEMP DEBUG (2026-08-19 growth bug): remove once the mover is proven.
  console.log(
    `[pill-resize] canonical=${JSON.stringify(pillSize)} readback=${JSON.stringify(pillWindow.getBounds())}`,
  );
}

/**
 * Let clicks fall through the window's invisible gutters — a transparent
 * window still eats every click inside its rectangle, shadow padding included.
 * `forward: true` keeps mouse-move events flowing to the page while ignored,
 * so the renderer can see the pointer return to real content and flip back.
 *
 * The forward hook is attached per page load and can silently die across a
 * renderer reload (Windows; live repro 2026-08-17: after a dev reload, the
 * first trip through the gutter left the window ignoring clicks FOREVER —
 * no mouse-moves arrived, so the renderer could never flip it back). While
 * ignoring, a heartbeat re-asserts the call every second to re-attach the
 * hook — ignoring can be wrong for at most a beat, never permanently.
 */
const IGNORE_HEARTBEAT_MS = 1000;
let ignoreHeartbeat: ReturnType<typeof setInterval> | null = null;

function stopIgnoreHeartbeat(): void {
  if (ignoreHeartbeat !== null) {
    clearInterval(ignoreHeartbeat);
    ignoreHeartbeat = null;
  }
}

export function setPillClickThrough(clickThrough: boolean): void {
  if (pillWindow === null || pillWindow.isDestroyed()) {
    stopIgnoreHeartbeat();
    return;
  }
  pillWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  stopIgnoreHeartbeat();
  if (clickThrough) {
    ignoreHeartbeat = setInterval(() => {
      if (pillWindow === null || pillWindow.isDestroyed()) {
        stopIgnoreHeartbeat();
        return;
      }
      pillWindow.setIgnoreMouseEvents(true, { forward: true });
    }, IGNORE_HEARTBEAT_MS);
  }
}
