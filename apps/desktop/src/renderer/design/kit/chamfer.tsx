import type { JSX, ReactNode } from "react";

import { Chamfer as ChamferCut } from "../tokens";

/**
 * The chamfered surface — Nova's control language on the web
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §3).
 *
 * ONE rule, encoded once: a 45° cut on the top-left and bottom-right corners
 * means the thing is actionable; square corners mean it is static. Mobile draws
 * the silhouette as an SVG polygon because React Native has no `clip-path`; the
 * web has it natively, and `calc()` inside `polygon()` keeps the cut an absolute
 * 8px at any box size — so this port needs no layout listener and no second
 * frame. Geometry is clipping only: the element's box is untouched, which is
 * what keeps every existing size exactly as it was.
 *
 * The hairline outline cannot survive `clip-path` (borders are clipped off at
 * the cuts), so the shape is two stacked layers: this element painted in the
 * stroke colour, and an inner fill inset by one pixel wearing the same polygon.
 * Both colours arrive from the caller's own CSS — this module knows no palette.
 */

/** The two cut sizes, re-exported so callers never hold a literal. */
export type ChamferSize = keyof typeof ChamferCut;

/**
 * The outline as a CSS `polygon()` — six vertices, clockwise from the top of
 * the top-left cut. Pure, so the geometry is testable without a renderer.
 */
export function chamferClipPath(cut: number): string {
  const c = `${String(cut)}px`;

  return (
    `polygon(${c} 0, 100% 0, 100% calc(100% - ${c}), ` +
    `calc(100% - ${c}) 100%, 0 100%, 0 ${c})`
  );
}

export interface ChamferProps {
  /** Which cut this surface takes: `control` (8px) or `key` (10px). */
  readonly cut?: ChamferSize;
  /** Extra class for the outer (stroke) layer — where callers set colours. */
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A chamfered box. The outer layer is the stroke, the inner is the fill; a
 * caller styles them through `.nova-chamfer` / `.nova-chamfer__fill` plus its
 * own class. Interactive semantics stay on the caller's own content — this is
 * a shape, not a button.
 */
export function Chamfer({
  cut = "control",
  className,
  children,
}: ChamferProps): JSX.Element {
  const clipPath = chamferClipPath(ChamferCut[cut]);
  const outer = ["nova-chamfer", className].filter(Boolean).join(" ");

  return (
    <div className={outer} style={{ clipPath }}>
      <div className="nova-chamfer__fill" style={{ clipPath }}>
        {children}
      </div>
    </div>
  );
}
