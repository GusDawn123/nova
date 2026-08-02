import { Space, type Palette } from './tokens';

/**
 * The floating tab bar's pure rules (`docs/DESIGN/notes-ui.md` §7.3) — the
 * measurements and colour decisions that must not drift from `app-tabs.tsx`, kept
 * here because `app-tabs.tsx` cannot be imported without a navigator.
 *
 * The mock replaced the native tab bar with a glass pill floating above the
 * content, which means `position: absolute` — and an absolutely positioned bar
 * reserves NO layout space. A native tab bar shrinks the screen for you; this one
 * does not, so every screen has to leave room for it deliberately.
 *
 * That obligation was invisible: the number lived in one screen's style block as a
 * literal, and the Live screen never got it — its "Start session" button rendered
 * underneath the bar, unreachable. Deriving it here from the bar's own dimensions
 * is what stops the next screen repeating that.
 */

/** The pill's height: one tab's `minHeight` plus the bar's padding, both sides. */
export const TAB_BAR_HEIGHT = 46 + 6 * 2;

/**
 * Vertical space a screen must leave free at the bottom so the bar never covers
 * anything interactive.
 *
 * @param insetBottom `useSafeAreaInsets().bottom` — the home-indicator inset. The
 *   bar floats above it, so a taller inset lifts the bar and content must retreat
 *   by the same amount.
 */
export function tabBarClearance(insetBottom: number): number {
  // Mirrors the bar's own `bottom` in app-tabs.tsx: the mock's 26px float, or the
  // inset plus a gap where a home indicator exists.
  const floatOffset = Math.max(Space.xxl, insetBottom + Space.md);

  return floatOffset + TAB_BAR_HEIGHT + Space.md;
}

/**
 * The record dot's colour, which cannot be one fixed token.
 *
 * The dot sits INSIDE a tab pill, and the FOCUSED pill is filled with `ink` — so an
 * ink-coloured dot disappears exactly when it matters most: during a live call, with
 * the Live tab selected, which is where the user normally is. It flips to `onInk`
 * there for the same reason the label does — `onInk` IS the canvas colour, the one
 * value guaranteed to read against a full-ink fill in both themes. On an unfocused
 * tab the surface underneath is the bar's translucent fill over canvas, where
 * `onInk` is the value that would vanish. So the rule is a flip, not a token.
 *
 * The duotone has no alarm colour (spec §11): what makes this a record light is its
 * pulse and its position, not a third hue.
 */
export function recordDotColor(palette: Palette, isFocused: boolean): string {
  return isFocused ? palette.onInk : palette.ink;
}
