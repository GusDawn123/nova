import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * The renderer's Content Security Policy, built per environment.
 *
 * `default-src 'none'` refuses anything not named below, so injected markup can
 * neither pull a script nor beacon out. The two loosenings are deliberate:
 * `style-src 'unsafe-inline'` because Vite injects its stylesheet inline in dev
 * and `design/theme.ts` paints tokens as inline custom properties, and the dev
 * `connect-src` because the HMR client needs its socket.
 *
 * The environments genuinely differ rather than differing for convenience. A
 * shipped build has no dev server to talk to, and it holds a bridge to account
 * data — so a blanket `ws:` there would be a standing exfiltration channel for
 * any code that ever ran unexpectedly. Production gets `connect-src 'self'`:
 * the renderer makes no network calls at all (every one is the main process's
 * job), so nothing legitimate is lost.
 */
function contentSecurityPolicy(): Plugin {
  const shared = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ];

  // The WHOLE attribute, not the bare token. Prose in the document explains
  // this mechanism and would otherwise be the first match `replace` found,
  // silently consuming the substitution and leaving the real tag untouched —
  // which is exactly what happened the first time this was written.
  const placeholder = 'content="%CSP%"';

  return {
    name: "nova-content-security-policy",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!html.includes(placeholder)) {
          // Loudly, because the failure is otherwise invisible: the window
          // simply loads with no policy at all and nothing looks wrong.
          throw new Error(
            `index.html is missing the ${placeholder} placeholder, so no Content-Security-Policy would be applied.`,
          );
        }
        // `ctx.server` exists only under `electron-vite dev`; a build has none.
        const isDev = ctx.server !== undefined;
        const connect = isDev
          ? // Loopback only, and only the schemes HMR actually uses — not a
            // bare `ws:`, which would permit a socket to any host on the
            // network while a developer is running the app.
            "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*"
          : "connect-src 'self'";
        const policy = [...shared, connect].join("; ");
        return html.replace(placeholder, `content="${policy}"`);
      },
    },
  };
}

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
      // Bundle this script's dependencies INTO it. Not optional, and the one
      // setting that governs it — electron-vite auto-applies its
      // `vite:externalize-deps` plugin unless this is false, so every
      // package.json dependency becomes a bare `require` at runtime.
      //
      // That default is right for the main process, which can resolve
      // node_modules, and fatal for a SANDBOXED preload, which cannot: a
      // sandboxed preload may require `electron` and a few polyfilled Node
      // builtins and nothing else. With the default, `require("zod")` throws,
      // the script dies BEFORE `exposeInMainWorld`, and the renderer gets no
      // bridge at all — the window paints its background and stops, with the
      // only evidence in the renderer's own console.
      //
      // Note this is NOT `ssr.noExternal` and NOT `rollupOptions.external`;
      // the preload preset already sets both, and neither overrides the plugin.
      externalizeDeps: false,
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
    plugins: [react(), contentSecurityPolicy()],
  },
});
