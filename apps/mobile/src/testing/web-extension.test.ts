import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/**
 * Where `*.web.*` source files are allowed to live.
 *
 * `vitest.config.mjs` puts the `.web.*` platform extensions FIRST in `resolve
 * .extensions`, so an extensionless import of `./thing` picks `thing.web.ts` over
 * `thing.ts`. That is exactly right for `apps/mobile`, whose suites run in jsdom
 * with `react-native` aliased to `react-native-web` — the web variant is the one the
 * code under test would really run against — and exactly WRONG for `apps/server` and
 * `packages/shared`, where Node is the target.
 *
 * The reach is repo-global: vitest 2.1 has no per-environment `resolve`, and scoping
 * it (a workspace split) would cost the `fileParallelism: false` guarantee the DB
 * suites depend on. So the config is safe only for as long as every `*.web.*` file
 * is under `apps/mobile` — which was a paragraph of prose in that file and nothing
 * more. This is that paragraph as an assertion: a `*.web.ts` appearing under the
 * server would otherwise hand its tests a browser variant, silently, with no failure
 * to trace it back from.
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

/** Tracked files only — untracked scratch and `node_modules` are not the repo. */
function trackedWebFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '*.web.*'], {
    cwd: repoRoot(),
    encoding: 'utf8',
  });

  return listed.split('\n').filter((line) => line !== '');
}

describe('platform-extension resolution', () => {
  it('keeps every *.web.* source under apps/mobile', () => {
    const strays = trackedWebFiles().filter(
      (file) => !file.startsWith('apps/mobile/'),
    );

    expect(
      strays,
      'a *.web.* file outside apps/mobile silently wins resolution in the ' +
        'node-environment suites too — scope resolve.extensions in ' +
        'vitest.config.mjs rather than deleting this test',
    ).toEqual([]);
  });

  it('is actually watching something', () => {
    // A guard that greps nothing passes forever. The two known files are the web
    // colour-scheme hook and the animated splash icon.
    expect(trackedWebFiles().length).toBeGreaterThan(0);
  });
});
