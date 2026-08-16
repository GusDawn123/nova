import type { JSX } from "react";

import { useAuthState } from "../../hooks/use-auth-state";
import { useMe } from "../../hooks/use-me";

/**
 * The Profile tab, wired to the real account: the identity block mirrors the
 * auth state main pushes, and the server section is a live `GET /me` — seeing
 * a user_id there means the whole chain held (session on disk, token
 * refreshed in main, JWT verified by the server). The mockup's placeholder
 * rows (add email, connected accounts) return when those features exist.
 */
export function ProfileTab(): JSX.Element {
  const auth = useAuthState();
  const { state: me, reload } = useMe();
  const email = auth.status === "signed-in" ? auth.user.email : undefined;

  return (
    <div className="card">
      <div className="card__title">Profile details</div>

      <div className="card__label">Profile</div>
      <div className="profile__identity">
        <span className="profile__avatar">
          {(email ?? "N").charAt(0).toUpperCase()}
        </span>
        <span className="profile__name">{email ?? "Signed-in account"}</span>
      </div>

      <div className="card__divider" />

      <div className="card__label" style={{ marginTop: 0 }}>
        Email addresses
      </div>
      <div className="profile__row">
        <span className="profile__value">
          {email ?? "No email on this account"}
        </span>
        <span className="chip-dim">Primary</span>
      </div>

      <div className="card__divider" />

      <div className="card__label" style={{ marginTop: 0 }}>
        Server account
      </div>
      {me.status === "loading" && (
        <span className="srow__desc">Asking the server…</span>
      )}
      {me.status === "error" && (
        <div className="profile__row">
          <span className="srow__desc">{me.message}</span>
          <button type="button" className="btn-outline" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {me.status === "success" && (
        <>
          <div className="profile__row">
            <span className="profile__meta">User ID</span>
            <span className="profile__value">{me.data.user_id}</span>
          </div>
          <div className="profile__row">
            <span className="profile__meta">Plan role</span>
            {/* Absent is a real answer: /me omits role on a DB-less server
                boot, and clients treat that as customer (adr-0008). */}
            <span className="profile__value">{me.data.role ?? "customer"}</span>
          </div>
        </>
      )}
    </div>
  );
}
