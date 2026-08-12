import { z } from "zod";

/**
 * The auth state, in the shape the RENDERER is allowed to see.
 *
 * Same four branches as the mobile app's `AuthState` (`hooks/use-auth.tsx`) —
 * `loading` and `unavailable` are separate from `signed-out` on purpose, because
 * "we do not know yet" and "this build has no Supabase config" both look like
 * signed-out and neither one should put a sign-in form on screen that could
 * never succeed.
 *
 * ONE deliberate difference: the mobile branch carries the whole Supabase
 * `Session`, and this one carries an identity. Tokens stay in the main process.
 * The renderer never needs one — every authed call is made for it over IPC — and
 * a refresh token that never crosses into a Chromium context cannot be read out
 * of one.
 */

export const authIdentitySchema = z.object({
  id: z.string(),
  email: z.string().optional(),
});
export type AuthIdentity = z.infer<typeof authIdentitySchema>;

export const authStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("loading") }),
  z.object({ status: z.literal("unavailable"), message: z.string() }),
  z.object({ status: z.literal("signed-out") }),
  z.object({ status: z.literal("signed-in"), user: authIdentitySchema }),
]);
export type AuthState = z.infer<typeof authStateSchema>;

/**
 * The part of a Supabase `Session` this projection reads. Structural rather than
 * the SDK's type so this module stays free of `@supabase/supabase-js` (the one
 * seam is `auth/supabase.ts`).
 */
export interface SessionIdentity {
  readonly user: {
    readonly id: string;
    readonly email?: string | undefined;
  };
}

/**
 * A Supabase session (or its absence) as the renderer's state. The conditional
 * spread rather than `email: session.user.email` is `exactOptionalPropertyTypes`:
 * an ABSENT email and an email explicitly set to `undefined` are different types
 * here, and only the former survives `JSON` on the way across IPC.
 */
export function projectAuthState(session: SessionIdentity | null): AuthState {
  if (session === null) {
    return { status: "signed-out" };
  }
  const { id, email } = session.user;
  return {
    status: "signed-in",
    user: { id, ...(email !== undefined ? { email } : {}) },
  };
}
