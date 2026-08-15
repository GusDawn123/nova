import { join } from "node:path";

import { BrowserWindow } from "electron";

import { hardenNavigation, loadRendererPage } from "./navigation";

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 760;

/**
 * The ordinary sign-in window from chunk 1. Not opened at startup any more —
 * the pill is the app's face now — but kept wired so the auth shell can return
 * when a later chunk gives sign-in a home in the new design.
 */
export async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    title: "Nova",
    // Nothing is drawn until the renderer has something to draw. Every later
    // window inherits this: the overlay must never flash on screen before its
    // capture-exclusion attributes have been applied, and a window that starts
    // hidden is the only way to guarantee that.
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      // The renderer is treated as hostile: no Node, no shared context with the
      // preload, and an OS-level sandbox around the process. The bridge in
      // src/preload is the only thing that crosses. These three are not tunable
      // — sandbox: false in particular would also be needed for an ESM preload,
      // which is why the preload is built as CommonJS instead.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.on("ready-to-show", () => {
    window.show();
  });

  hardenNavigation(window);
  await loadRendererPage(window, "index.html");
  return window;
}
