import { join } from "node:path";

import { BrowserWindow, screen } from "electron";

import type { ScreenPrivacyService } from "../privacy/screen-privacy";
import { hardenNavigation, loadRendererPage } from "./navigation";
import {
  settingsWindowSize,
  SETTINGS_TITLE_BAR_HEIGHT,
} from "./settings-layout";

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

  // Sized to the screen, not the design: the renderer zooms the fixed-size
  // design to fit (settings-layout.ts owns the law for both sides).
  const { workArea } = screen.getPrimaryDisplay();
  const { width, height } = settingsWindowSize(workArea.width, workArea.height);

  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    resizable: false,
    show: false,
    title: "Nova Settings",
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
    settingsWindow = null;
  });

  hardenNavigation(window);
  settingsWindow = window;
  try {
    await loadRendererPage(window, "settings.html");
  } catch (error) {
    // A window that failed to load must not stay latched as "the settings
    // window" — the next open would show/focus a blank shell forever.
    settingsWindow = null;
    if (!window.isDestroyed()) {
      window.destroy();
    }
    throw error;
  }
}

export function closeSettingsWindow(): void {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
}
