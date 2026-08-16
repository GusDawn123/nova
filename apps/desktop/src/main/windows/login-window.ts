import { join } from "node:path";

import { BrowserWindow, screen } from "electron";

import type { ScreenPrivacyService } from "../privacy/screen-privacy";
import { hardenNavigation, loadRendererPage } from "./navigation";
import {
  settingsWindowSize,
  SETTINGS_TITLE_BAR_HEIGHT,
} from "./settings-layout";

let loginWindow: BrowserWindow | null = null;

/**
 * The sign-in window — the app's front door while nobody is signed in. Wears
 * the settings window's exact chrome and sizing law so the two read as one
 * app; the login VISUALS are a stand-in for a later design pass, but the
 * Supabase seam behind them is already the real one.
 *
 * Attached to the screen-privacy service like every Nova window: signing back
 * in mid-share while Nova is hidden must not flash a window into the share.
 */
export async function openLoginWindow(
  privacy: ScreenPrivacyService,
): Promise<void> {
  if (loginWindow !== null && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }

  const { width, height } = settingsWindowSize(
    screen.getPrimaryDisplay().workArea.width,
  );

  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    resizable: false,
    show: false,
    title: "Nova",
    backgroundColor: "#0c0c0e",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0c0c0e",
      symbolColor: "#ececef",
      height: SETTINGS_TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  privacy.attach(window);

  window.on("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    loginWindow = null;
  });

  hardenNavigation(window);
  // Assigned before the page loads so a second call during the load is a
  // no-op instead of a second window — auth pushes can arrive in bursts.
  loginWindow = window;
  await loadRendererPage(window, "index.html");
}

export function closeLoginWindow(): void {
  if (loginWindow !== null && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
}
