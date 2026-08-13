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

  hardenNavigation(window);
  await loadRenderer(window);
  return window;
}

/**
 * Pin the renderer to the one document it was built to show.
 *
 * `contextIsolation` and `sandbox` limit what a renderer can DO; neither limits
 * where it can GO. Without these two handlers, any injected or mistaken
 * navigation — a stray `window.open`, a link with `target="_blank"`, a
 * `location.href` — either replaces our UI with a remote page that then sits
 * behind the same preload bridge, or opens a fresh Electron window with default
 * (weaker) webPreferences. Both are the standard Electron escalation path, and
 * both are closed here rather than trusted not to happen.
 */
function hardenNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    // The app has nothing to pop up. If a later chunk needs an external link
    // (a docs page, a password reset), it opens in the user's real browser via
    // shell.openExternal — never in a window holding our bridge.
    console.warn(`[window] blocked a new-window request to ${url}`);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const current = new URL(window.webContents.getURL());
    // Same-document navigation is how the dev server's HMR client reloads, so
    // the origin is compared rather than the whole URL. In a packaged build
    // both sides are `file://` and the origins match as `null`, which is why
    // the href is checked too.
    const sameOrigin =
      target.origin === current.origin && target.origin !== "null";
    const sameFile =
      target.protocol === "file:" && target.pathname === current.pathname;
    if (sameOrigin || sameFile) {
      return;
    }
    event.preventDefault();
    console.warn(`[window] blocked a navigation to ${url}`);
  });
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
