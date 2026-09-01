import type { LiveSessionView } from "./use-live-session";

/** Words for an ask with no live session to ask about — never a silent no-op. */
export const ASK_NEEDS_SESSION =
  "Start an audio session first — Nova answers about the live call.";

/**
 * The bar's one-line notice for a session that stopped without the user's
 * stop click. The server's own reason when it gave one; honest fallbacks when
 * it didn't. A user-initiated stop is not news and returns null.
 */
export function sessionEndNotice(
  state: LiveSessionView["state"],
  message: string | null,
  userStopped: boolean,
): string | null {
  if (state === "error") {
    return message ?? "The session hit an error and stopped.";
  }
  if (state === "ended" && !userStopped) {
    return message ?? "The session ended on its own.";
  }
  return null;
}
