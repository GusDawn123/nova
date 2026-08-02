import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * Expo Router owns `apps/mobile/src/app/` — every file under it is a ROUTE.
 *
 * That makes a co-located screen test actively dangerous in a way no gate here can
 * see. Metro bundles `sign-in.test.tsx` into the app and mounts it as a route; the
 * vitest import at its module scope throws `Vitest failed to access its internal
 * state` as an uncaught error at launch, and `_layout.test.tsx` additionally collides
 * with the real layout ("layouts _layout.tsx and _layout.test.tsx conflict on the
 * route"). Meanwhile `vitest run`, `tsc --noEmit` and `expo lint` are all green: the
 * failure exists only in the running router, on device, which is the worst possible
 * place to discover it.
 *
 * Screen tests therefore live in `apps/mobile/src/screen-tests/` (see the README
 * there). This is that rule as an assertion, in the same shape as the `*.web.*`
 * invariant beside it: ask git, not the filesystem, so untracked scratch files do not
 * fail the build and `node_modules` is never walked.
 */

/**
 * Asked of git rather than derived from `import.meta.url`: this file runs in the
 * jsdom environment, where `import.meta.url` is not a `file:` URL and cannot be
 * resolved to a path.
 */
function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

const ROUTER_DIR = 'apps/mobile/src/app';

/** Tracked files only — untracked scratch and `node_modules` are not the repo. */
function trackedRouterFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--', ROUTER_DIR], {
    cwd: repoRoot(),
    encoding: 'utf8',
  });

  return listed.split('\n').filter((line) => line !== '');
}

describe('expo-router directory', () => {
  it('holds no test files', () => {
    const strays = trackedRouterFiles().filter((file) =>
      /\.(test|spec)\./.test(file),
    );

    expect(
      strays,
      'a test file under src/app/ is bundled as a ROUTE and crashes the running ' +
        'app on launch, while every gate stays green — move it to ' +
        'apps/mobile/src/screen-tests/ rather than deleting this test',
    ).toEqual([]);
  });

  it('is actually watching something', () => {
    // A guard that greps nothing passes forever.
    expect(trackedRouterFiles().length).toBeGreaterThan(0);
  });
});
