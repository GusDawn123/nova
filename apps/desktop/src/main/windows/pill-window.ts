import { join } from "node:path";

import { BrowserWindow, screen } from "electron";

import type { ScreenPrivacyService } from "../privacy/screen-privacy";
import { hardenNavigation, loadRendererPage } from "./navigation";

/**
 * The window is wider than the pill so the CSS drop shadow has somewhere to
 * land — a transparent window clips at its own bounds, and a shadow cut off in
 * a hard rectangle reads as a rendering bug. The renderer's shell reserves the
 * same margins, so the numbers live in one place each side of the boundary.
 */
const WINDOW_WIDTH = 860;
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
  const { workArea } = screen.getPrimaryDisplay();

  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: INITIAL_HEIGHT,
    x: workArea.x + Math.round((workArea.width - WINDOW_WIDTH) / 2),
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
  await loadRendererPage(window, "pill.html");

  pillWindow = window;
  return window;
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
  pillWindow.setContentSize(WINDOW_WIDTH, height);
}
