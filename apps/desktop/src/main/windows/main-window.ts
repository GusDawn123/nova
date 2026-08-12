import { join } from "node:path";

import { BrowserWindow } from "electron";

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 760;

/**
 * The one visible window. Later chunks add the stealth overlay beside it; this
 * is the ordinary window the user signs in through.
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

  await loadRenderer(window);
  return window;
}

/**
 * In `electron-vite dev` the renderer is served by Vite (HMR); in a built app it
 * is a file on disk next to the compiled main process.
 */
async function loadRenderer(window: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined) {
    await window.loadURL(devServerUrl);
    return;
  }
  await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}
