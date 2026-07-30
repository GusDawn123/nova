import { Space } from './tokens';

/**
 * Layout metrics for the floating tab bar (`docs/DESIGN/notes-ui.md` §7.3).
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
