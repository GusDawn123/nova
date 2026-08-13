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
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";

/** Loopback is the one place a bearer token may travel unencrypted. */
function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * Resolve the base URL, with development and production held to different bars.
 *
 * DEV falls back to the local server so `electron-vite dev` works with no `.env`
 * at all — the same posture as the mobile app.
 *
 * PRODUCTION fails closed instead, and deliberately so. These values are inlined
 * at BUILD time, so a missing or malformed one can only come from a broken build
 * — never from anything a user did. The old behaviour was to quietly fall back
 * to `127.0.0.1:3000`, which on a customer's machine means every request dies
 * against nothing and the app looks broken for a reason no log explains. A build
 * that forgot its API URL should not get that far.
 *
 * HTTPS is required off loopback for the obvious reason: every request carries a
 * bearer token in a header.
 */
export function resolveApiBaseUrl(
  raw: unknown,
  isDevelopment: boolean,
): string {
  const parsed = z.string().url().safeParse(raw);

  if (!parsed.success) {
    if (isDevelopment) {
      return DEFAULT_API_BASE_URL;
    }
    throw new Error(
      "NOVA_API_URL was missing or malformed when this app was built. A packaged build must be built with a valid server URL.",
    );
  }

  const url = new URL(parsed.data);
  if (!isDevelopment && url.protocol !== "https:" && !isLoopback(url)) {
    throw new Error(
      `NOVA_API_URL must use https outside development (got ${url.protocol}//). Access tokens travel in request headers.`,
    );
  }

  return parsed.data;
}

export const API_BASE_URL = resolveApiBaseUrl(
  import.meta.env.NOVA_API_URL,
  import.meta.env.DEV,
);
