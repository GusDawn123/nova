import { describe, expect, it } from "vitest";

import {
  settingsWindowSize,
  settingsZoom,
  SETTINGS_CONTENT_DESIGN_HEIGHT,
  SETTINGS_DESIGN_WIDTH,
  SETTINGS_SCREEN_FRACTION,
  SETTINGS_TITLE_BAR_HEIGHT,
} from "./settings-layout";

describe("settings window sizing", () => {
  it("takes its fraction of the screen's width", () => {
    expect(settingsWindowSize(1920, 1080).width).toBe(
      Math.round(1920 * SETTINGS_SCREEN_FRACTION),
    );
  });

  it("keeps the design's aspect below an unscaled title strip", () => {
    const { width, height } = settingsWindowSize(1920, 1080);
    const contentHeight = height - SETTINGS_TITLE_BAR_HEIGHT;
    // Content scales as one block: its aspect ratio is the design's.
    expect(contentHeight / width).toBeCloseTo(
      SETTINGS_CONTENT_DESIGN_HEIGHT / SETTINGS_DESIGN_WIDTH,
      2,
    );
  });

  it("zooms to exactly fill the window it computed", () => {
    const { width } = settingsWindowSize(2560, 1440);
    expect(settingsZoom(width) * SETTINGS_DESIGN_WIDTH).toBeCloseTo(width);
  });

  it("shrinks to fit a screen whose height is the constraint", () => {
    // An ultrawide: 2/3 of 3440 is 2293 wide, whose content alone would be
    // ~1467 tall — taller than the 1440 screen. The window must fit instead.
    const { width, height } = settingsWindowSize(3440, 1440);
    expect(height).toBeLessThanOrEqual(1440);
    expect(width).toBeLessThan(Math.round(3440 * SETTINGS_SCREEN_FRACTION));
    // Still the design's aspect below the title strip.
    expect((height - SETTINGS_TITLE_BAR_HEIGHT) / width).toBeCloseTo(
      SETTINGS_CONTENT_DESIGN_HEIGHT / SETTINGS_DESIGN_WIDTH,
      2,
    );
  });
});
