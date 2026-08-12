import { app, BrowserWindow } from "electron";

import { createMainWindow } from "./windows/main-window";

async function bootstrap(): Promise<void> {
  await app.whenReady();
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
