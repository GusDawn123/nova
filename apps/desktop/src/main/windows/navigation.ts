import { join } from "node:path";

import type { BrowserWindow } from "electron";

/**
 * Navigation hardening and renderer loading, shared by every window.
 *
 * Extracted from main-window.ts the day the app grew a second and third window
 * (the pill and the settings window): a security boundary that exists as three
 * copies is a boundary that drifts, and the copy that drifted is always the one
 * that gets exploited.
 */

/**
 * Pin a renderer to the one document it was built to show.
 *
 * `contextIsolation` and `sandbox` limit what a renderer can DO; neither limits
 * where it can GO. Without these two handlers, any injected or mistaken
 * navigation — a stray `window.open`, a link with `target="_blank"`, a
 * `location.href` — either replaces our UI with a remote page that then sits
 * behind the same preload bridge, or opens a fresh Electron window with default
 * (weaker) webPreferences. Both are the standard Electron escalation path, and
 * both are closed here rather than trusted not to happen.
 */
export function hardenNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    // The app has nothing to pop up. If a later chunk needs an external link
    // (a docs page, a password reset), it opens in the user's real browser via
    // shell.openExternal — never in a window holding our bridge.
    console.warn(`[window] blocked a new-window request to ${url}`);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isSameDocumentNavigation(url, window.webContents.getURL())) {
      return;
    }
    event.preventDefault();
    console.warn(`[window] blocked a navigation to ${url}`);
  });
}

/**
 * Whether a requested navigation stays inside the document we loaded.
 *
 * Pure and exported so the decision has its own test: this is a security
 * boundary, and the version living inside an Electron event handler could only
 * be checked by launching the app.
 *
 * Two accepted shapes, because dev and production differ. Under the dev server
 * both sides are `http://localhost:5173` and the ORIGIN matches — that is how
 * the HMR client reloads. In a packaged build both are `file://`, whose origin
 * serialises to the string `"null"`; comparing origins there would accept any
 * file on disk, so the path is compared instead.
 */
export function isSameDocumentNavigation(
  targetUrl: string,
  currentUrl: string,
): boolean {
  let target: URL;
  let current: URL;
  try {
    target = new URL(targetUrl);
    current = new URL(currentUrl);
  } catch {
    // Unparseable is not something we recognise, and the default is to refuse.
    return false;
  }

  if (target.protocol === "file:" || current.protocol === "file:") {
    return (
      target.protocol === "file:" &&
      current.protocol === "file:" &&
      target.pathname === current.pathname
    );
  }

  return target.origin === current.origin && target.origin !== "null";
}

/**
 * In `electron-vite dev` the renderer is served by Vite (HMR); in a built app it
 * is a file on disk next to the compiled main process. `page` is the HTML file's
 * name — the renderer build has one per window (index / pill / settings).
 */
export async function loadRendererPage(
  window: BrowserWindow,
  page: string,
): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined) {
    await window.loadURL(`${devServerUrl}/${page}`);
    return;
  }
  await window.loadFile(join(import.meta.dirname, "../renderer", page));
}
