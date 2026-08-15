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
    expect(settingsWindowSize(1920).width).toBe(
      Math.round(1920 * SETTINGS_SCREEN_FRACTION),
    );
  });

  it("keeps the design's aspect below an unscaled title strip", () => {
    const { width, height } = settingsWindowSize(1920);
    const contentHeight = height - SETTINGS_TITLE_BAR_HEIGHT;
    // Content scales as one block: its aspect ratio is the design's.
    expect(contentHeight / width).toBeCloseTo(
      SETTINGS_CONTENT_DESIGN_HEIGHT / SETTINGS_DESIGN_WIDTH,
      2,
    );
  });

  it("zooms to exactly fill the window it computed", () => {
    const { width } = settingsWindowSize(2560);
    expect(settingsZoom(width) * SETTINGS_DESIGN_WIDTH).toBeCloseTo(width);
  });
});
