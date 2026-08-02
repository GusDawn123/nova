import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Root vitest config. The DB integration suites all run against ONE local Supabase
 * Postgres, and some Phase 5 operations scan the shared `jobs`/`meetings` tables
 * GLOBALLY (atomic claim, sweep-enqueue, stale-call reaper). Those are only
 * deterministic — as the notes recovery/race tests must be (adr-0006 §3) — when no
 * two suites race against the same rows, so test FILES run sequentially. Within a
 * file, tests still run in order; the added wall-clock cost is small and buys
 * flake-free integration coverage.
 *
 * Written as `.mjs` (plain JS) so eslint's type-aware project service does not need a
 * tsconfig entry for it — same treatment as `eslint.config.mjs`.
 *
 * ---------------------------------------------------------------------------
 * Mobile (Phase 8.5, `docs/DESIGN/notes-ui.md` §9)
 * ---------------------------------------------------------------------------
 * `apps/mobile` had no test infrastructure at all. It gets `jsdom` and renders
 * through `react-native-web` — the SAME path Expo Web already builds, so this is a
 * real target the app ships to rather than a shim invented for testing.
 *
 * Be clear about what that does and does not prove. These tests exercise component
 * structure, props, state, and the pure logic underneath. They do NOT prove native
 * layout, native gestures, or anything about how iOS renders a blur — the mock's
 * glass is verified on the simulator by eye, not here. Native-only modules are
 * mocked in `apps/mobile/src/testing/setup.ts`.
 *
 * The alternative, `@testing-library/react-native` over `react-test-renderer`, is
 * Jest-shaped and fights this repo's vitest setup for no gain at this layer: the
 * assertions worth making are about behaviour, not about the native tree.
 */

const mobileSrc = fileURLToPath(new URL("./apps/mobile/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // `@/…` is mobile-only (the server and shared use relative imports), so a
      // global alias is unambiguous — checked before adding it.
      { find: /^@\/(.*)$/, replacement: `${mobileSrc}/$1` },
      // react-native → react-native-web, so RN primitives resolve to their DOM
      // implementations under jsdom. Exact match only: `react-native-web`,
      // `react-native-svg` etc. must NOT be caught by it.
      { find: /^react-native$/, replacement: "react-native-web" },
      // react-native-svg declares no `exports` map, so the bare specifier resolves by
      // `main` — the CommonJS build, which vite hands straight to Node and which
      // reaches react-native's Flow source. Point at the ESM build instead: that one
      // vite processes itself, which is what lets the alias above and the `.web.*`
      // extensions below apply to everything the package imports internally.
      {
        find: /^react-native-svg$/,
        replacement: "react-native-svg/lib/module/index.js",
      },
    ],
    // `.web.*` FIRST — the platform-extension convention Metro and the Expo web
    // build both use, which vite does not know about on its own. Packages that ship
    // a browser implementation alongside the native one (react-native-svg) name it
    // `elements.web.js` next to `elements.js` and import it extensionless, with no
    // `exports` map to disambiguate; without this the native file wins and drags in
    // react-native's untranspiled Flow source, which Node cannot parse.
    //
    // This DOES also redirect two of our own modules — `hooks/use-color-scheme.web.ts`
    // (reached extensionless from `hooks/use-theme.ts`, so it is live for anything
    // that themes itself) and `components/animated-icon.web.tsx` (from
    // `app/_layout.tsx`). That is the INTENDED resolution and not collateral: these
    // suites run in jsdom and already alias `react-native` to `react-native-web`, so
    // the web variant is the one the code under test would actually run against.
    // Picking the native file here would be the wrong answer, not the safe one.
    //
    // REACH: this block is repo-global — the server and shared suites resolve under
    // it too, because vitest 2.1 has no per-environment `resolve`, and the only way
    // to scope it (a `vitest.workspace.ts` split) would cost the `fileParallelism:
    // false` guarantee the DB suites below depend on. It is safe today because the
    // two files above are the ONLY `*.web.*` sources in the repo and both are under
    // `apps/mobile`. What would make it unsafe: a `*.web.*` file appearing under
    // `apps/server` or `packages/shared`, where node — not a browser — is the real
    // target, and where this ordering would silently hand tests the browser variant.
    // If that day comes, scope this properly rather than deleting the entries.
    extensions: [
      ".web.mjs",
      ".web.js",
      ".web.mts",
      ".web.ts",
      ".web.jsx",
      ".web.tsx",
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
    ],
  },
  test: {
    fileParallelism: false,
    server: {
      deps: {
        // react-native-svg has to go THROUGH vite rather than round Node: only then
        // do the `react-native` alias and the `.web.*` extensions above apply to its
        // internals. Externalised, it loads its native build and throws a syntax
        // error before any test runs.
        inline: ["react-native-svg"],
      },
    },
    // Only mobile gets a DOM. Server and shared suites stay on `node`, where
    // installing jsdom globals would be pure overhead and could mask a real
    // Node-only assumption.
    environmentMatchGlobs: [["apps/mobile/**", "jsdom"]],
    setupFiles: ["./apps/mobile/src/testing/setup.ts"],
  },
});
