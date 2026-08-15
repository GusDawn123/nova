import type { JSX } from "react";

import { GoogleIcon } from "../../design/icons";

/**
 * The Profile tab, verbatim from the mockup — placeholder identity data until
 * the auth seam feeds this window.
 */
export function ProfileTab(): JSX.Element {
  return (
    <div className="card">
      <div className="card__title">Profile details</div>

      <div className="card__label">Profile</div>
      <div className="profile__identity">
        <span className="profile__avatar">G</span>
        <span className="profile__name">Gustavo Rosas</span>
        <a
          href="#"
          onClick={(event) => {
            event.preventDefault();
          }}
        >
          Update profile
        </a>
      </div>

      <div className="card__divider" />

      <div className="card__label" style={{ marginTop: 0 }}>
        Email addresses
      </div>
      <div className="profile__row">
        <span className="profile__value">gustavo@tcinteractivegroup.com</span>
        <span className="chip-dim">Primary</span>
        <button type="button" className="dots">
          ···
        </button>
      </div>
      <a
        href="#"
        className="profile__add"
        onClick={(event) => {
          event.preventDefault();
        }}
      >
        <span className="profile__add-plus">+</span>Add email address
      </a>

      <div className="card__divider" />

      <div className="card__label" style={{ marginTop: 0 }}>
        Connected accounts
      </div>
      <div className="profile__row">
        <GoogleIcon size={18} />
        <span className="profile__provider">Google</span>
        <span className="profile__meta">· gustavo@tcinteractivegroup.com</span>
        <button type="button" className="dots">
          ···
        </button>
      </div>
      <a
        href="#"
        className="profile__add"
        onClick={(event) => {
          event.preventDefault();
        }}
      >
        <span className="profile__add-plus">+</span>Connect account
      </a>
    </div>
  );
}
