import type { JSX } from "react";

/**
 * The Security tab, verbatim from the mockup — placeholder devices until the
 * auth seam feeds this window.
 */
export function SecurityTab(): JSX.Element {
  return (
    <div className="card">
      <div className="card__title">Security</div>

      <div className="card__label">Password</div>
      <a
        href="#"
        className="security__link"
        onClick={(event) => {
          event.preventDefault();
        }}
      >
        Set password
      </a>

      <div className="card__divider" />

      <div className="card__label" style={{ marginTop: 0, marginBottom: 18 }}>
        Active devices
      </div>
      <div className="device">
        <span className="device__frame" />
        <div className="device__info">
          <span className="device__name-row">
            <span className="device__name">Macintosh</span>
            <span className="chip-dim">This device</span>
          </span>
          <span className="device__meta">Electron 40.8.0</span>
          <span className="device__meta">
            2603:900b:1040:2c2:2c7d:a1db:37d5:fc51 (Kissimmee, United States)
          </span>
          <span className="device__meta">Today at 9:05 PM</span>
        </div>
      </div>
      <div className="device">
        <span className="device__frame" />
        <div className="device__info">
          <span className="device__name">Macintosh</span>
          <span className="device__meta">Chrome 151.0.0.0</span>
          <span className="device__meta">
            2603:9001:f00:136d:8104:126a:3026:636d (Orlando, United States)
          </span>
          <span className="device__meta">Today at 3:04 PM</span>
        </div>
        <button type="button" className="dots">
          ···
        </button>
      </div>

      <div className="card__divider" style={{ margin: "26px 0 22px" }} />
      <button type="button" className="security__delete">
        Delete account
      </button>
    </div>
  );
}
