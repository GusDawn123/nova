import type { JSX } from "react";

/**
 * Scanlines — the hologram texture
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7): 1px lines every
 * 4px at ~5% ink, wherever a surface should read as projected, not printed.
 *
 * Mobile pays one SVG rect per 4 points; the web pays a single
 * `repeating-linear-gradient`, drawn in `kit.css` with the spec's numbers.
 * STATIC BY DESIGN — no motion branch, because there is no motion to reduce.
 *
 * `aria-hidden` for the same reason mobile's `decorative` ruling exists: a
 * sighted reader takes this as atmosphere; a screen reader, given nothing,
 * walks into it. It carries no information, so it is hidden outright.
 */
export function Scanlines({ className }: { readonly className?: string }): JSX.Element {
  const outer = ["nova-scanlines", className].filter(Boolean).join(" ");

  return <div className={outer} aria-hidden="true" />;
}
