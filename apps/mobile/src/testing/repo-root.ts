import { execFileSync } from 'node:child_process';

/**
 * The repository root, for the structural suites that assert on FILES rather than on
 * rendered output (`router-directory.test.ts`, `web-extension.test.ts`).
 *
 * Asked of git rather than derived from `import.meta.url`: those suites run in the
 * jsdom environment, where `import.meta.url` is not a `file:` URL and cannot be
 * resolved to a path.
 */
export function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}
