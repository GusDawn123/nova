import { app, BrowserWindow } from "electron";

import { createApiClient } from "./api/client";
import { API_BASE_URL } from "./api/config";
import { createAuthService } from "./auth/service";
import { registerIpcHandlers } from "./ipc/handlers";
import { createMainWindow } from "./windows/main-window";

/**
 * Composition root. Everything with a dependency is built here and injected;
 * nothing below reaches for a singleton it was not handed.
 *
 * Auth and HTTP both live in this process, and that is the architectural point
 * of the desktop app rather than an implementation detail. The server's CORS
 * allowlist (`apps/server/src/app.ts`) admits `localhost`/`127.0.0.1` origins;
 * a packaged renderer loads from `file://` and sends `Origin: null`, which
 * matches neither, while the main process sends no `Origin` at all and is never
 * subject to CORS — the position the native mobile app already occupies. It is
 * also where the later chunks need this to be: audio capture is a main-process
 * concern, and an overlay renderer cannot be trusted to hold state at all.
 */
async function bootstrap(): Promise<void> {
  await app.whenReady();

  const auth = createAuthService();
  const api = createApiClient({
    baseUrl: API_BASE_URL,
    fetch: globalThis.fetch,
    // A function rather than the token itself: an access token expires, and
    // `getAccessToken` refreshes it. Handing the client a string once would
    // work all afternoon and fail overnight.
    //
    // Wrapped rather than passed by reference so the call keeps its receiver —
    // a detached method would be invoked with the wrong `this` the day the
    // service stops being a closure over its state.
    getAccessToken: () => auth.getAccessToken(),
  });

  const disposeIpc = registerIpcHandlers({ auth, api });
  app.on("will-quit", () => {
    disposeIpc();
    auth.dispose();
  });

  await createMainWindow();
}

// Windows and Linux expect a desktop app to exit with its last window. macOS
// expects the opposite: the process stays alive in the dock until the user
// quits it explicitly.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// The other half of that bargain — on macOS the dock icon can be clicked while
// the app is running with no windows at all, and that click has to be able to
// build one again.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length > 0) {
    return;
  }
  createMainWindow().catch((error: unknown) => {
    console.error("[main] failed to reopen the main window:", error);
  });
});

bootstrap().catch((error: unknown) => {
  console.error("[main] failed to start:", error);
  app.quit();
});
