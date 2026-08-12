import { z } from "zod";

/**
 * Where the Nova server lives, read from env at the boundary.
 *
 * Its own module rather than a constant inside `client.ts` for the same reason
 * the mobile app keeps `API_BASE_URL` in `constants/health.ts`: this is the only
 * line in the api layer that touches `import.meta.env`, and separating it keeps
 * `client.ts` a pure module the preload bundle can borrow a schema from without
 * dragging an env read into a process that has no env prefix configured.
 */
const DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";

/**
 * Zod-parsed with a fallback to the local dev server, so `electron-vite dev`
 * works with no `.env` at all — the same posture as the mobile app. `.catch()`
 * rather than `.optional()`: a MALFORMED url deserves the fallback too, and
 * failing to boot over a typo in an optional variable helps nobody.
 */
export const API_BASE_URL = z
  .string()
  .url()
  .catch(DEFAULT_API_BASE_URL)
  .parse(import.meta.env.NOVA_API_URL);
