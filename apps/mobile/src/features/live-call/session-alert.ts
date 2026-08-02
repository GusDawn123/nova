import { liveErrorCodeSchema } from '@nova/shared';

/**
 * What the screen does with `useLiveSession.errorMessage`
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4 — Live screen states).
 *
 * The hook flattens every typed server error into `"<code>: <message>"`, which is
 * the only channel this screen has for telling apart the two shapes the spec draws:
 *
 *   - a spent QUOTA, which ends the call and takes the whole screen with plain copy
 *     and NO retry — nothing a press here can do mints more quota;
 *   - everything else, which is one mono line under the HUD rail while the session
 *     carries on (degraded vendor, a rejected frame, a transport failure).
 *
 * The code is PARSED against the wire's own closed set rather than matched as a
 * substring, so a message that merely contains the word is text, not a state.
 */

export type LiveAlert =
  | { readonly kind: 'quota' }
  | { readonly kind: 'banner'; readonly text: string };

/** `"code: message"` split into its two halves, when the code is a real one. */
function splitTypedError(
  errorMessage: string,
): { code: string; message: string } | null {
  const separator = errorMessage.indexOf(': ');
  if (separator === -1) return null;

  const code = errorMessage.slice(0, separator);
  if (!liveErrorCodeSchema.safeParse(code).success) return null;

  return { code, message: errorMessage.slice(separator + 2) };
}

export function liveAlertFor(errorMessage: string | null): LiveAlert | null {
  if (errorMessage === null) return null;

  const typed = splitTypedError(errorMessage);
  if (typed === null) {
    // Not a wire event — the transport's own words ("connection error — is the
    // server running?"). Shown whole; splitting on its first colon would eat the
    // sentence.
    return { kind: 'banner', text: errorMessage };
  }

  if (typed.code === 'quota_exceeded') return { kind: 'quota' };

  // The machine code has done its job by now; the human half is what is readable.
  return { kind: 'banner', text: typed.message };
}
