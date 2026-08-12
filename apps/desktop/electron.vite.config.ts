import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Entry points follow electron-vite's convention — src/main/index.ts,
// src/preload/index.ts, src/renderer/index.html — so none of them are spelled
// out here.
export default defineConfig({
  main: {
    // electron-vite loads `.env` from the project root and exposes only the
    // variables carrying a configured prefix on `import.meta.env` (its
    // documented mechanism — the defaults are MAIN_VITE_ / PRELOAD_VITE_ /
    // RENDERER_VITE_ / VITE_). Nova's are named for what they are rather than
    // for which bundle they land in, so the prefix is overridden here.
    //
    // Declared on `main` ALONE, and that is a security boundary rather than a
    // tidiness one: preload and renderer keep electron-vite's defaults, so a
    // NOVA_* value can never be substituted into the renderer bundle. Every
    // network call lives in the main process (the server's CORS allowlist
    // rejects a `file://` renderer's `Origin: null`), so nothing downstream has
    // any business reading them.
    //
    // Values are inlined at BUILD time, exactly as Expo does for the mobile
    // app's EXPO_PUBLIC_* vars. Fine for what these are — a public project URL
    // and a publishable anon key — and no vendor secret may ever join them
    // (RULES §11).
    envPrefix: "NOVA_",
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          // Electron runs a sandboxed preload as plain CommonJS; ESM preloads
          // require `sandbox: false`, which this app will not trade away. The
          // `.cjs` extension is load-bearing on top of that: the workspace is
          // `"type": "module"`, so a `.js` preload would be read as ESM and
          // fail to load at all.
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
