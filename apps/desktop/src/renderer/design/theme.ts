import {
  cobaltPalette,
  FontSize,
  Radius,
  Size,
  Space,
  type Palette,
} from "./tokens";

/**
 * The bridge from `tokens.ts` — which is shared verbatim with the mobile app and
 * knows nothing about CSS — to the custom properties `index.css` paints with.
 *
 * Written this way round on purpose: the token file stays the single source of
 * the duotone spine, and this module is the only place a token becomes a CSS
 * name. Nothing in the stylesheet may hold a literal colour, so a third colour
 * would have to be added HERE, in one visible place, to reach the screen at all
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §11 — risk and failure
 * are said in words, never in ink).
 */

/**
 * The three type voices are named but not shipped. `tokens.FontFamily` holds
 * React Native font-ASSET keys (`Orbitron_900Black`) which mean nothing to CSS,
 * and bundling the real faces is a later chunk's job. The stacks below ask for
 * the brand family first and fall back to the platform's own, so installing the
 * faces later is a no-op change here.
 */
const FontStack = {
  display: '"Orbitron", "Inter", system-ui, sans-serif',
  body: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Space Mono", ui-monospace, "Cascadia Mono", "Consolas", monospace',
} as const;

function px(value: number): string {
  return `${String(value)}px`;
}

/** Every token this UI paints with, as CSS custom properties. */
export function themeVariables(palette: Palette): Record<string, string> {
  return {
    "--nova-canvas": palette.canvas,
    "--nova-ink": palette.ink,
    "--nova-ink-soft": palette.inkSoft,
    "--nova-ink-faint": palette.inkFaint,
    "--nova-ink-hairline": palette.inkHairline,
    "--nova-ink-fill": palette.inkFill,
    "--nova-on-ink": palette.onInk,

    "--nova-font-display": FontStack.display,
    "--nova-font-body": FontStack.body,
    "--nova-font-mono": FontStack.mono,

    "--nova-text-display-lg": px(FontSize.displayLg),
    "--nova-text-display-sm": px(FontSize.displaySm),
    "--nova-text-body": px(FontSize.body),
    "--nova-text-body-sm": px(FontSize.bodySm),
    "--nova-text-mono": px(FontSize.mono),
    "--nova-text-mono-sm": px(FontSize.monoSm),

    "--nova-space-xs": px(Space.xs),
    "--nova-space-xs2": px(Space.xs2),
    "--nova-space-sm": px(Space.sm),
    "--nova-space-sm2": px(Space.sm2),
    "--nova-space-md": px(Space.md),
    "--nova-space-lg": px(Space.lg),
    "--nova-space-xl": px(Space.xl),
    "--nova-space-xxl": px(Space.xxl),

    "--nova-radius-card": px(Radius.card),
    "--nova-radius-panel": px(Radius.panel),
    "--nova-radius-button": px(Radius.button),
    "--nova-radius-chip": px(Radius.chip),

    "--nova-tap-target": px(Size.tapTarget),
    "--nova-dot": px(Size.dot),
  };
}

/**
 * Paint a palette onto the document. Cobalt by default — the mirror (`paper`) is
 * chosen in Account on mobile, and this app has no Account yet, so there is
 * nothing here that could ask for it.
 */
export function applyTheme(
  root: HTMLElement,
  palette: Palette = cobaltPalette,
): void {
  for (const [name, value] of Object.entries(themeVariables(palette))) {
    root.style.setProperty(name, value);
  }
}
