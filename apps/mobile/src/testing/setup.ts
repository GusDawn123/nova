/**
 * Vitest setup for `apps/mobile` (Phase 8.5, `docs/DESIGN/notes-ui.md` §9).
 *
 * Registers the jest-dom matchers (`toBeInTheDocument`, `toHaveTextContent`, …) so
 * component assertions read the way they do everywhere else.
 *
 * vitest's `setupFiles` is GLOBAL — it runs for every project, and splitting the
 * config into workspace projects purely to scope it would restructure the server
 * suites for no benefit. So the import is guarded on there actually being a DOM.
 * Unguarded it cost ~2s per full run, loading matchers into 120+ node-environment
 * files that will never use them.
 *
 * Anything genuinely mobile-only (native module mocks) belongs in the test file that
 * needs it, where `vi.mock`'s hoisting actually applies.
 */
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
