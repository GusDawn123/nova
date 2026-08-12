# FROZEN — 2026-08-11

**This app is frozen. Do not add features to it, and do not expect it to build.**

Nova pivoted from a mobile client to a desktop (Electron) one on 2026-08-11. The
reason is in
[`docs/superpowers/specs/2026-08-11-desktop-pivot-design.md`](../../docs/superpowers/specs/2026-08-11-desktop-pivot-design.md)
§1: on a phone, hearing both sides of a call was only ever possible
acoustically, and iOS gives no microphone access during a cellular call at all.
Desktop taps the audio stream before it reaches the speaker, which removes the
problem rather than working around it.

What that means for this directory, as of the desktop scaffold (chunk 1):

- **Out of the npm workspaces list.** The root `package.json` now names its
  workspaces explicitly (`packages/*`, `apps/server`, `apps/desktop`), so
  `npm install` no longer installs this app's dependencies.
- **Out of `npm run typecheck` and `npm run lint`.** Both root scripts dropped
  their `--workspace apps/mobile` tail.
- **Out of `npm run test`.** `vitest.config.mjs` excludes `apps/mobile/**`; its
  46 suites no longer run, since without installed dependencies they would fail
  on resolution rather than on anything true.
- **Still on disk, and still in git.** Nothing was deleted. The duotone design
  system under `src/design/` is the reference the desktop renderer draws from,
  and every commit of this app's history is reachable from `git log`.

Deleting it outright is an open decision (pivot doc §8.1 — the standing
preference is to delete after chunk 4, once the desktop renderer has taken what
it needs). Until then, treat this tree as documentation.
