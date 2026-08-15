import { join } from "node:path";

import { BrowserWindow } from "electron";

import type { ScreenPrivacyService } from "../privacy/screen-privacy";
import { hardenNavigation, loadRendererPage } from "./navigation";

// The mockup's native design size: an 1150-wide panel, ~140 of title + tabs
// and a 640 content pane.
const WIDTH = 1150;
const HEIGHT = 780;
/** Matches the custom title bar the renderer draws, so the native
 * minimize/maximize/close cluster sits vertically centered on it. */
const TITLE_BAR_HEIGHT = 44;

let settingsWindow: BrowserWindow | null = null;

/**
 * The settings window — one per app, reopened on demand. Attached to the
 * screen-privacy service at birth for the same reason the pill is: opened
 * mid-share while Nova is hidden, it must be born hidden.
 *
 * Windows variant (docs/superpowers/mockups/2026-08-14-app-design/WINDOWS-VARIANT.md):
 * the native window controls, on the right, drawn by the OS over our dark
 * title bar — not the mockup's macOS traffic lights.
 */
export async function openSettingsWindow(
  privacy: ScreenPrivacyService,
): Promise<void> {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    resizable: false,
    show: false,
    title: "Nova Settings",
    backgroundColor: "#0c0c0e",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0c0c0e",
      symbolColor: "#ececef",
      height: TITLE_BAR_HEIGHT,
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
    settingsWindow = null;
  });

  hardenNavigation(window);
  settingsWindow = window;
  await loadRendererPage(window, "settings.html");
}
