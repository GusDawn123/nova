import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * Where `*.web.*` source files are allowed to live.
 *
 * `vitest.config.mjs` puts the `.web.*` platform extensions FIRST in
 * `resolve.extensions`, so an extensionless import of `./thing` resolves
 * `thing.web.ts` ahead of `thing.ts`. That is right for `apps/mobile`, whose
 * suites run in jsdom with `react-native` aliased to `react-native-web`, and
 * wrong everywhere else — `apps/server`, `packages/shared` and `apps/desktop`'s
 * main process all target Node.
 *
 * The reach is repo-global: vitest 2.1 has no per-environment `resolve`, and
 * scoping it would cost the `fileParallelism: false` guarantee the DB suites
 * depend on. So the config is safe only for as long as every `*.web.*` file
 * stays under `apps/mobile`. A stray one under the server would silently hand
 * its tests a browser variant, with no failure to trace it back from.
 *
 * WHY IT LIVES HERE: this guard was `apps/mobile/src/testing/web-extension.test.ts`
 * until that tree was frozen out of the workspaces list and excluded from
 * vitest — which stopped the guard running without removing the resolver
 * behaviour it guards. It moved to the live client workspace rather than being
 * deleted with the app it happened to sit in. It asserts a repo-wide invariant
 * and has no desktop-specific content.
 */

/**
 * `git ls-files` lists only what is UNDER its working directory. Run from
 * anywhere but the repo root it silently narrows to that subtree, and a guard
 * that quietly checks less than it claims is worse than no guard — it would
 * pass while a stray `*.web.ts` sat under `apps/server`. The original in
 * `apps/mobile` resolved the root for this reason; dropping it in the move was
 * a real weakening, so the root is resolved explicitly rather than inherited
 * from whatever cwd the runner happens to use.
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

/** Tracked files only — untracked scratch and `node_modules` are not the repo. */
function trackedWebFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "*.web.*"], {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  return listed.split("\n").filter((line) => line !== "");
}

describe("platform-extension resolution", () => {
  it("keeps every *.web.* source under apps/mobile", () => {
    const strays = trackedWebFiles().filter(
      (file) => !file.startsWith("apps/mobile/"),
    );

    expect(strays).toEqual([]);
  });
});
