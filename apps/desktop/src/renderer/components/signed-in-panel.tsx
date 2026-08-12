import { useState, type JSX } from "react";

import type { AuthActionResult } from "../../main/auth/errors";
import type { AuthIdentity } from "../../main/auth/state";
import { useMe } from "../hooks/use-me";

/**
 * What this chunk exists to prove: a desktop client signed in through Supabase,
 * and the existing TypeScript server answered its authed `GET /me`.
 *
 * So the three fields are shown raw rather than prettified. `user_id`, `email`
 * and `role` come off the wire through the shared `meResponseSchema` — the same
 * schema the mobile app parses — and seeing them here means the whole round trip
 * held: session on disk, token refreshed in main, `Authorization` header
 * accepted, JWT verified, `profiles.role` read, response parsed.
 */

export interface SignedInPanelProps {
  readonly user: AuthIdentity;
  readonly signOut: () => Promise<AuthActionResult>;
}

export function SignedInPanel({
  user,
  signOut,
}: SignedInPanelProps): JSX.Element {
  const { state, reload } = useMe();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailure, setSignOutFailure] = useState<string | null>(null);

  async function leave(): Promise<void> {
    setSigningOut(true);
    setSignOutFailure(null);
    const result = await signOut();
    if (result.ok) {
      // Nothing to reset — main pushes `signed-out` and this panel unmounts.
      return;
    }
    setSigningOut(false);
    setSignOutFailure(result.message);
  }

  return (
    <>
      <span className="eyebrow">Signed in</span>
      <h1 className="wordmark">{user.email ?? "Nova"}</h1>
      <p className="lede">
        The desktop app is holding a Supabase session in its main process and
        calling the Nova server with it.
      </p>

      <span className="eyebrow">GET /me</span>
      {state.status === "loading" && <MeLoading />}
      {state.status === "error" && (
        <div className="notice" role="alert">
          <span className="eyebrow">Could not read your account</span>
          <p className="notice__body">{state.message}</p>
        </div>
      )}
      {state.status === "success" && (
        <dl className="identity">
          <IdentityRow label="user_id" value={state.data.user_id} />
          <IdentityRow label="email" value={state.data.email} />
          {/* Absent is a real answer here: `/me` omits `role` on a DB-less
              server boot, and clients treat that as `customer` (adr-0008). */}
          <IdentityRow label="role" value={state.data.role} />
        </dl>
      )}

      <div className="actions">
        <button
          className="key key--quiet"
          type="button"
          disabled={state.status === "loading"}
          onClick={reload}
        >
          Call /me again
        </button>
        <button
          className="key"
          type="button"
          disabled={signingOut}
          onClick={() => {
            void leave();
          }}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>

      {signOutFailure !== null && (
        <div className="notice" role="alert">
          <span className="eyebrow">Still signed in</span>
          <p className="notice__body">{signOutFailure}</p>
        </div>
      )}
    </>
  );
}

function MeLoading(): JSX.Element {
  return (
    <p className="status-line">
      <span className="status-line__dot status-line__dot--hollow" />
      Asking the server
    </p>
  );
}

function IdentityRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value?: string | undefined;
}): JSX.Element {
  return (
    <div className="identity__row">
      <dt className="eyebrow">{label}</dt>
      <dd
        className={
          value === undefined
            ? "identity__value identity__value--absent"
            : "identity__value"
        }
      >
        {value ?? "not sent"}
      </dd>
    </div>
  );
}
