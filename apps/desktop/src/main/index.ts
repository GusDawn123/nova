import { app, BrowserWindow } from "electron";

import { createApiClient } from "./api/client";
import { API_BASE_URL } from "./api/config";
import { createAuthService } from "./auth/service";
import type { AuthState } from "./auth/state";
import { registerIpcHandlers } from "./ipc/handlers";
import { createScreenPrivacy } from "./privacy/screen-privacy";
import { closeLoginWindow, openLoginWindow } from "./windows/login-window";
import {
  closePillWindow,
  createPillWindow,
  resizePillWindow,
  setPillClickThrough,
} from "./windows/pill-window";
import {
  closeSettingsWindow,
  openSettingsWindow,
} from "./windows/settings-window";

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
// One owner for the undetectability flag, module-scoped because macOS's
// `activate` can rebuild the pill after bootstrap finished and the new window
// must attach to the SAME state, not a fresh one. It starts DETECTABLE
// (Gustavo's call for the first Windows test: launch visible, toggle live);
// every window attaches at creation and is born wearing the current state.
const privacy = createScreenPrivacy();

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

  const disposeIpc = registerIpcHandlers({
    auth,
    api,
    privacy,
    openSettings: () => {
      openSettingsWindow(privacy).catch((error: unknown) => {
        console.error("[main] failed to open the settings window:", error);
      });
    },
    resizePill: resizePillWindow,
    setPillClickThrough,
  });
  app.on("will-quit", () => {
    disposeIpc();
    auth.dispose();
  });

  // The boot gate: which windows exist is a function of auth state, nothing
  // else. `loading` builds nothing — supabase resolves it from disk in a
  // moment, and waiting is what lets a remembered session boot straight into
  // the pill with no sign-in flash.
  //
  // Ordering inside each branch matters: the replacement window is CREATED
  // before the old ones close, so the window count never touches zero — on
  // Windows, zero windows is `window-all-closed`, which quits the app.
  const syncWindowsToAuth = (state: AuthState): void => {
    if (state.status === "loading") {
      return;
    }
    if (state.status === "signed-in") {
      createPillWindow(privacy)
        .then(() => {
          // Re-checked: auth may have flipped while the pill loaded, and a
          // stale continuation must not close the login window a NEWER
          // sign-out just opened. If it flipped, undo this branch's window
          // instead — the newer sync already put the right one up.
          if (auth.getState().status === "signed-in") {
            closeLoginWindow();
          } else {
            closePillWindow();
          }
        })
        .catch((error: unknown) => {
          console.error("[main] failed to open the pill window:", error);
        });
      return;
    }
    // signed-out and unavailable both mean "the front door": the login window
    // renders the right screen for each.
    openLoginWindow(privacy)
      .then(() => {
        // Same staleness check, mirrored.
        if (auth.getState().status !== "signed-in") {
          closePillWindow();
          closeSettingsWindow();
        } else {
          closeLoginWindow();
        }
      })
      .catch((error: unknown) => {
        console.error("[main] failed to open the login window:", error);
      });
  };
  auth.subscribe(syncWindowsToAuth);
  syncWindowsToAuth(auth.getState());

  // macOS: a dock-icon click while the app has no windows must rebuild the
  // right one for the current auth state. Registered here because it needs
  // `auth`; Windows never reaches it (the app quits with its last window).
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      syncWindowsToAuth(auth.getState());
    }
  });
}

// Windows and Linux expect a desktop app to exit with its last window. macOS
// expects the opposite: the process stays alive in the dock until the user
// quits it explicitly.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

bootstrap().catch((error: unknown) => {
  console.error("[main] failed to start:", error);
  app.quit();
});
