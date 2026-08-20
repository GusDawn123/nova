import { describe, expect, it } from "vitest";

import {
  clampRectToArea,
  nudgeRect,
  PILL_MOVE_STEP_PX,
  type Rect,
} from "./pill-move";

/**
 * [pill-move] The mover's pure math: one step per press in the pressed
 * direction, and no sequence of presses can strand the pill off-screen.
 */

const PILL: Rect = { x: 500, y: 100, width: 800, height: 160 };
const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

describe("windows/pill-move", () => {
  it("nudges one step in each direction, size untouched", () => {
    expect(nudgeRect(PILL, "up")).toEqual({
      ...PILL,
      y: PILL.y - PILL_MOVE_STEP_PX,
    });
    expect(nudgeRect(PILL, "down")).toEqual({
      ...PILL,
      y: PILL.y + PILL_MOVE_STEP_PX,
    });
    expect(nudgeRect(PILL, "left")).toEqual({
      ...PILL,
      x: PILL.x - PILL_MOVE_STEP_PX,
    });
    expect(nudgeRect(PILL, "right")).toEqual({
      ...PILL,
      x: PILL.x + PILL_MOVE_STEP_PX,
    });
  });

  it("clamps at every edge of the work area (never stranded off-screen)", () => {
    // Pushed past the left/top corner → pinned to the corner.
    expect(
      clampRectToArea({ ...PILL, x: AREA.x - 999, y: AREA.y - 999 }, AREA),
    ).toEqual({ ...PILL, x: AREA.x, y: AREA.y });
    // Pushed past the right/bottom corner → pinned fully inside.
    expect(
      clampRectToArea(
        { ...PILL, x: AREA.width + 999, y: AREA.height + 999 },
        AREA,
      ),
    ).toEqual({
      ...PILL,
      x: AREA.x + AREA.width - PILL.width,
      y: AREA.y + AREA.height - PILL.height,
    });
    // Already inside → untouched (a work area with a taskbar offset, too).
    const offsetArea: Rect = { x: 1920, y: 40, width: 1920, height: 1000 };
    const inside: Rect = { ...PILL, x: 2000, y: 200 };
    expect(clampRectToArea(inside, offsetArea)).toEqual(inside);
  });
});
