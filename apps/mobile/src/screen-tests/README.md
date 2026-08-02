# screen-tests

Tests for the Expo Router screens under `src/app/`, kept **outside** that directory.

Expo Router treats **every** file under `src/app/` as a route. A test file co-located
next to its screen is therefore bundled by Metro into the running app: `sign-in.test.tsx`
becomes a route, `_layout.test.tsx` collides with `_layout.tsx` ("layouts `_layout.tsx`
and `_layout.test.tsx` conflict on the route"), and the vitest import at module scope
throws `Vitest failed to access its internal state` as an uncaught error on launch.

Nothing in the normal gates catches it. `vitest run`, `tsc`, and `expo lint` all stay
green — the crash only exists in the running router, on device. So the rule is
structural, not a matter of taste:

> No `*.test.*` file may live under `apps/mobile/src/app/`.

`src/testing/router-directory.test.ts` asserts exactly that and fails the build if one
reappears.

## Naming

Files here are named for the screen they cover, flattening the route structure:

| test                      | screen                              |
| ------------------------- | ----------------------------------- |
| `root-layout.test.tsx`    | `app/_layout.tsx`                   |
| `sign-in.test.tsx`        | `app/(auth)/sign-in.tsx`            |
| `sign-up.test.tsx`        | `app/(auth)/sign-up.tsx`            |
| `app-layout.test.tsx`     | `app/(app)/_layout.tsx`             |
| `tabs-index.test.tsx`     | `app/(app)/(tabs)/index.tsx`        |
| `tabs-live.test.tsx`      | `app/(app)/(tabs)/live.tsx`         |
| `tabs-account.test.tsx`   | `app/(app)/(tabs)/account.tsx`      |
| `meeting-detail.test.tsx` | `app/(app)/meetings/[id].tsx`       |

The screen under test is imported by relative path back into `src/app/`; every other
import stays on the `@/…` alias, unchanged by the move.
