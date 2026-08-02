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
    ],
  },
  test: {
    fileParallelism: false,
    // Only mobile gets a DOM. Server and shared suites stay on `node`, where
    // installing jsdom globals would be pure overhead and could mask a real
    // Node-only assumption.
    environmentMatchGlobs: [["apps/mobile/**", "jsdom"]],
    setupFiles: ["./apps/mobile/src/testing/setup.ts"],
  },
});
