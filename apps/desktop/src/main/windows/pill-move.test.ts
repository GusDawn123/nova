import { describe, expect, it } from "vitest";

import {
  clampRectToArea,
  moveWindowBy,
  nudgeRect,
  PILL_MOVE_STEP_PX,
  resizeWindowTo,
  type MovableWindow,
  type PillSize,
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

/**
 * [dpi-regression] The 2026-08-19 growth bug, encoded: on a scaled display
 * the OS readback of window SIZE lies (live trace at scale 1.25: every
 * read-modify-write gained a pixel, width 1143 -> 1173 over a dozen presses).
 * This fake window lies the same way - getBounds() reports size one pixel
 * larger than whatever was last set - and the mover/resizer must never
 * launder that lie into the size they write. If either ever sources size
 * from readback again, the drift assertions below catch it.
 */
class LyingDpiWindow implements MovableWindow {
  position: { x: number; y: number };
  setWidths: number[] = [];
  setHeights: number[] = [];

  constructor(
    start: { x: number; y: number },
    private lastSetSize: PillSize,
  ) {
    this.position = { ...start };
  }

  getBounds(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      // The lie: readback size is always one pixel bigger than reality.
      width: this.lastSetSize.width + 1,
      height: this.lastSetSize.height + 1,
    };
  }

  setBounds(bounds: Rect): void {
    this.position = { x: bounds.x, y: bounds.y };
    this.lastSetSize = { width: bounds.width, height: bounds.height };
    this.setWidths.push(bounds.width);
    this.setHeights.push(bounds.height);
  }

  setContentSize(width: number, height: number): void {
    this.lastSetSize = { width, height };
    this.setWidths.push(width);
    this.setHeights.push(height);
  }

  setResizable(): void {
    // The dance is real but sizeless - nothing to fake.
  }
}

const BIG_AREA: Rect = { x: 0, y: 0, width: 10000, height: 10000 };

describe("windows/pill-move [dpi-regression] canonical size never drifts", () => {
  it("100 move+resize cycles against a lying readback: every written size is canonical", () => {
    const canonical: PillSize = { width: 1143, height: 232 };
    let size = canonical;
    const fake = new LyingDpiWindow({ x: 57, y: 5000 }, canonical);

    for (let i = 0; i < 100; i++) {
      // One press, then the renderer's ResizeObserver reaction - the exact
      // sequence from the live trace.
      moveWindowBy(fake, size, i % 2 === 0 ? "up" : "down", () => BIG_AREA);
      size = resizeWindowTo(fake, size, canonical.height);
    }

    // The window moved...
    expect(fake.setWidths.length).toBeGreaterThan(0);
    // ...but every size ever WRITTEN is exactly the canonical one: the +1
    // lie in readback never leaked into a write, so growth is impossible.
    expect(new Set(fake.setWidths)).toEqual(new Set([canonical.width]));
    expect(new Set(fake.setHeights)).toEqual(new Set([canonical.height]));
    expect(size).toEqual(canonical);
  });

  it("a height change re-anchors the canonical size instead of reading it back", () => {
    const fake = new LyingDpiWindow(
      { x: 0, y: 0 },
      { width: 800, height: 160 },
    );
    const grown = resizeWindowTo(fake, { width: 800, height: 160 }, 480);
    expect(grown).toEqual({ width: 800, height: 480 });
    // The lying readback (801) must not appear in what was written.
    expect(fake.setWidths).toEqual([800]);
  });
});
