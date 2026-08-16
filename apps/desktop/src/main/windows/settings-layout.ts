/**
 * The settings window's sizing law, shared by both sides of the process
 * boundary: main sizes the OS window from it, and the renderer zooms the
 * fixed-size design to fit whatever window it got. One module so the two can
 * never disagree. Pure numbers only — no electron import, so the renderer
 * bundle can carry it.
 *
 * The design is drawn at a fixed 1150×(44+736); rather than reflow it for a
 * smaller window, the content below the title strip scales uniformly (the
 * proportions stay exactly the mockup's, per Gustavo's 2026-08-15 sizing
 * pass). The title strip does NOT scale: the native window controls ride it
 * (titleBarOverlay), and window chrome has to stay finger-sized.
 */

/** The slice of screen width the settings window occupies — THE tuning knob. */
export const SETTINGS_SCREEN_FRACTION = 2 / 3;

/** The width the mockup is drawn at. Do not change without redrawing. */
export const SETTINGS_DESIGN_WIDTH = 1150;

/** Design height of everything below the title strip (tab bar + pane). */
export const SETTINGS_CONTENT_DESIGN_HEIGHT = 736;

/** The unscaled title strip; also the titleBarOverlay height. */
export const SETTINGS_TITLE_BAR_HEIGHT = 44;

/** The zoom that fits the design's width into a window of `windowWidth`. */
export function settingsZoom(windowWidth: number): number {
  return windowWidth / SETTINGS_DESIGN_WIDTH;
}

/** The window's content size for a given screen (work area) size. */
export function settingsWindowSize(
  screenWidth: number,
  screenHeight: number,
): {
  width: number;
  height: number;
} {
  const widthFromFraction = Math.round(screenWidth * SETTINGS_SCREEN_FRACTION);
  // On an ultrawide display, 2/3 of the width computes a window taller than
  // the screen (the design is taller than it is wide, proportionally). The
  // window then takes the widest size whose height still fits instead.
  const widthThatFitsHeight = Math.floor(
    ((screenHeight - SETTINGS_TITLE_BAR_HEIGHT) /
      SETTINGS_CONTENT_DESIGN_HEIGHT) *
      SETTINGS_DESIGN_WIDTH,
  );
  const width = Math.min(widthFromFraction, widthThatFitsHeight);
  return {
    width,
    height:
      SETTINGS_TITLE_BAR_HEIGHT +
      Math.round(SETTINGS_CONTENT_DESIGN_HEIGHT * settingsZoom(width)),
  };
}
