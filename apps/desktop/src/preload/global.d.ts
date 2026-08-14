import type { NovaBridge } from "./index";

// The renderer sees the bridge as a property of `window`, put there by
// contextBridge at load time rather than by any code TypeScript can follow.
// This declaration is what connects the two halves.
//
// why the file is not named `index.d.ts`: TypeScript's `include` resolution
// drops a `foo.d.ts` whenever `foo.ts` sits beside it — it assumes the former is
// the latter's build output. `src/preload/index.d.ts` would therefore be
// silently absent from the program, and `window.novaBridge` would stay untyped
// with nothing to show for it. (The electron-vite template gets away with that
// name only because its preload source and its declarations live in two
// different tsconfig projects.)
//
// The type is imported rather than restated, so the renderer's view of the
// bridge and the object the preload actually exposes cannot drift: adding a
// member to `NovaBridge` without exposing it, or exposing one without declaring
// it, fails the build in `src/preload/index.ts`.
declare global {
  interface Window {
    readonly novaBridge: NovaBridge;
  }
}
