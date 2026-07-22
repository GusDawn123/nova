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
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
