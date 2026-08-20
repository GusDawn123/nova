/**
 * The pill-mover's pure math (Ctrl+Arrows, Gustavo's 2026-08-19 pick). Kept
 * free of electron imports so the nudge and clamp rules are unit-testable;
 * pill-window.ts owns the hotkey wiring and the live display lookup.
 */

/**
 * Pixels per press. Windows auto-repeats a held RegisterHotKey combo, so a
 * modest step still glides when the key is held instead of teleporting.
 */
export const PILL_MOVE_STEP_PX = 30;

export type MoveDirection = "up" | "down" | "left" | "right";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Shift a rectangle one step in a direction (clamping is the caller's job). */
export function nudgeRect(
  rect: Rect,
  direction: MoveDirection,
  step: number = PILL_MOVE_STEP_PX,
): Rect {
  switch (direction) {
    case "up":
      return { ...rect, y: rect.y - step };
    case "down":
      return { ...rect, y: rect.y + step };
    case "left":
      return { ...rect, x: rect.x - step };
    case "right":
      return { ...rect, x: rect.x + step };
  }
}

/**
 * Keep the window findable: the whole rectangle stays inside the display's
 * work area, so no sequence of presses can strand the pill off-screen.
 */
export function clampRectToArea(rect: Rect, area: Rect): Rect {
  const x = Math.min(
    Math.max(rect.x, area.x),
    area.x + area.width - rect.width,
  );
  const y = Math.min(
    Math.max(rect.y, area.y),
    area.y + area.height - rect.height,
  );
  return { ...rect, x, y };
}
