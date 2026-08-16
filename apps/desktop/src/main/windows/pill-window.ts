import { join } from "node:path";

import { BrowserWindow, screen } from "electron";

import type { ScreenPrivacyService } from "../privacy/screen-privacy";
import { hardenNavigation, loadRendererPage } from "./navigation";

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
  window.on("closed", () => {
    pillWindow = null;
  });

  hardenNavigation(window);
  // Assigned before the page loads so a second call during the load returns
  // this window instead of building another one.
  pillWindow = window;
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

/**
 * Size the window to the pill's content. The pill grows downward (history,
 * transcript, the mode menu), so width and position stay put and only the
 * height follows. Height is already bounds-checked at the IPC boundary.
 */
export function resizePillWindow(height: number): void {
  if (pillWindow === null || pillWindow.isDestroyed()) {
    return;
  }
  // Frameless window: bounds and content size are the same rectangle, and
  // getBounds() has the honest non-optional type.
  pillWindow.setContentSize(pillWindow.getBounds().width, height);
}

/**
 * Let clicks fall through the window's invisible gutters — a transparent
 * window still eats every click inside its rectangle, shadow padding included.
 * `forward: true` keeps mouse-move events flowing to the page while ignored,
 * so the renderer can see the pointer return to real content and flip back.
 */
export function setPillClickThrough(clickThrough: boolean): void {
  if (pillWindow === null || pillWindow.isDestroyed()) {
    return;
  }
  pillWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
}
