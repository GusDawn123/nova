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

/** The pill's CANONICAL size — the one true size, owned by us, never the OS. */
export interface PillSize {
  width: number;
  height: number;
}

/**
 * The subset of BrowserWindow the mover/resizer touch, swappable in tests
 * with a fake whose readback lies the way Windows DPI scaling does.
 */
export interface MovableWindow {
  getBounds(): Rect;
  setBounds(bounds: Rect): void;
  setContentSize(width: number, height: number): void;
  setResizable(resizable: boolean): void;
}

/**
 * THE LAW THIS FILE EXISTS TO ENFORCE (root cause of the 2026-08-19 growth
 * bug; live trace: width 1143 → 1173 over a dozen presses at scale 1.25):
 * on a DPI-scaled display the window's size is not exactly representable in
 * both pixel systems, so any read-modify-write of size through getBounds()
 * gains a pixel per round trip and the pill grows forever. Therefore size is
 * ALWAYS written from the canonical {@link PillSize} and NEVER sourced from
 * readback — readback is trusted for POSITION only, where a ±1 rounding
 * cannot accumulate into anything visible.
 */
export function moveWindowBy(
  window: MovableWindow,
  size: PillSize,
  direction: MoveDirection,
  workAreaFor: (rect: Rect) => Rect,
): void {
  const pos = window.getBounds();
  const tentative = nudgeRect({ x: pos.x, y: pos.y, ...size }, direction);
  const clamped = clampRectToArea(tentative, workAreaFor(tentative));
  // Non-resizable windows mis-handle bounds writes on scaled displays — the
  // known dance: lift the lock, write position + canonical size, lock again.
  window.setResizable(true);
  window.setBounds({ x: clamped.x, y: clamped.y, ...size });
  window.setResizable(false);
}

/**
 * Height changes (the pill grows downward) — the new height becomes canonical
 * and the width is RE-ASSERTED from the canonical size, never read back.
 * Returns the new canonical size for the caller to store.
 */
export function resizeWindowTo(
  window: MovableWindow,
  size: PillSize,
  height: number,
): PillSize {
  window.setContentSize(size.width, height);
  return { width: size.width, height };
}
