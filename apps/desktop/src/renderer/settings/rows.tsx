import type { JSX, ReactNode } from "react";

/**
 * The settings window's shared row grammar — a section heading, an icon-tile
 * row with a trailing control, and the 46×27 toggle — used by most tabs so a
 * spacing tweak lands everywhere at once.
 */

export function SectionHead({
  title,
  sub,
  spaced = false,
}: {
  readonly title: string;
  readonly sub?: string;
  readonly spaced?: boolean;
}): JSX.Element {
  return (
    <div className={spaced ? "section-head section-head--spaced" : "section-head"}>
      <span className="section-title">{title}</span>
      {sub !== undefined && <span className="section-sub">{sub}</span>}
    </div>
  );
}

export function SettingRow({
  icon,
  title,
  desc,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly desc: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="srow">
      <span className="srow__icon">{icon}</span>
      <div className="srow__text">
        <span className="srow__title">{title}</span>
        <span className="srow__desc">{desc}</span>
      </div>
      {children}
    </div>
  );
}

export function Toggle({
  on,
  onToggle,
  label,
}: {
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={on ? "toggle toggle--on" : "toggle"}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
    >
      <span className="toggle__knob" />
    </button>
  );
}
