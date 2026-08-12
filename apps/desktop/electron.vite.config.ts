import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Entry points follow electron-vite's convention — src/main/index.ts,
// src/preload/index.ts, src/renderer/index.html — so none of them are spelled
// out here.
export default defineConfig({
  main: {},
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
