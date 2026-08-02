import { describe, expect, it } from 'vitest';

import {
  BURST_MS,
  DOUBLE_OFFSET_MS,
  SLICE_HEIGHT_RATIO,
  eventDurationMs,
  glitchFrameAt,
  patchOpacityAt,
} from './mascot-glitch';

/**
 * The hologram tear, as arithmetic
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7, demo-verified against
 * `mascot-alive-v2.html` — the approved intensity).
 *
 * ONE clock drives the eyes and the tear, so the property worth proving is not that
 * each channel has a nice shape but that they READ THE SAME `t`: at the instant her
 * eyes are shut the ghosts are split, and at rest every channel is invisible. Both are
 * asserted below, and neither is provable through a renderer.
 *
 * The rest-state assertion is load-bearing in a way that is easy to miss: the stage
 * parks its shared value at the END of the timeline between blinks, so a channel that
 * did not return to zero at `t = duration` would leave a ghost permanently on screen.
 */

/** Where the eyes are fully shut — the middle of the close, in either burst. */
const SHUT_MS = 80;

/**
 * The floor on how long a double blink's eyes stay open between its two closes.
 * Three frames at 60Hz — below that the reopening is not a thing anyone sees, and the
 * double stops being a double.
 */
const MIN_OPEN_MS = 50;

describe('the blink/glitch timeline', () => {
  it('is completely at rest at both ends of a burst', () => {
    for (const t of [0, BURST_MS]) {
      const frame = glitchFrameAt(t, false);

      expect(patchOpacityAt(t, false)).toBe(0);
      expect(frame.ghostA).toEqual({ opacity: 0, translateX: 0 });
      expect(frame.ghostB).toEqual({ opacity: 0, translateX: 0 });
      expect(frame.slice.opacity).toBe(0);
      expect(frame.track.opacity).toBe(0);
      expect(frame.jitter).toBe(0);
      expect(frame.scanBoost).toBe(0);
    }
  });

  it('is at rest at the end of a DOUBLE event too', () => {
    // The stage leaves the value parked here until the next blink. A double runs
    // longer than a single, so a timeline that only zeroed at 200ms would strand the
    // second burst mid-tear.
    const end = eventDurationMs(true);
    expect(end).toBeGreaterThan(eventDurationMs(false));

    expect(patchOpacityAt(end, true)).toBe(0);
    expect(glitchFrameAt(end, true).ghostA.opacity).toBe(0);
    expect(glitchFrameAt(end, true).slice.opacity).toBe(0);
    expect(glitchFrameAt(end, true).track.opacity).toBe(0);
  });

  it('shuts the eyes for about 140ms', () => {
    // Spec §7: "~140ms closes". Measured midpoint-to-midpoint of the two cross-fades,
    // which is what an eye actually reads as the length of a blink.
    const closed = (t: number): boolean => patchOpacityAt(t, false) >= 0.5;
    const samples = Array.from({ length: BURST_MS + 1 }, (_, t) => t).filter(closed);
    const width = (samples.at(-1) ?? 0) - (samples[0] ?? 0);

    expect(patchOpacityAt(SHUT_MS, false)).toBe(1);
    expect(width).toBeGreaterThanOrEqual(130);
    expect(width).toBeLessThanOrEqual(150);
  });

  it('closes twice, with the eyes open in between, on a double', () => {
    expect(patchOpacityAt(SHUT_MS, true)).toBe(1);
    // The gap: the first close has finished and the second has not begun.
    expect(patchOpacityAt(DOUBLE_OFFSET_MS - 5, true)).toBe(0);
    expect(patchOpacityAt(DOUBLE_OFFSET_MS + SHUT_MS, true)).toBe(1);

    // A single blink at the same instant is long over — this is the whole difference.
    expect(patchOpacityAt(DOUBLE_OFFSET_MS + SHUT_MS, false)).toBe(0);
  });

  it('holds the eyes open between the closes long enough to be SEEN', () => {
    // The bug the plan's 180ms offset had, and the reason this assertion exists at all:
    // the gap was arithmetically real (16ms) and perceptually absent — one frame at
    // 60Hz. A double has to read as two blinks, not as one close that stuttered, so
    // the number worth pinning is the open window rather than the offset.
    const everyMs = Array.from({ length: eventDurationMs(true) + 1 }, (_, t) => t);
    const shut = everyMs.filter((t) => patchOpacityAt(t, true) > 0);
    const first = shut[0] ?? 0;
    const last = shut.at(-1) ?? 0;
    const openMs = everyMs.filter(
      (t) => t > first && t < last && patchOpacityAt(t, true) === 0,
    ).length;

    expect(openMs).toBeGreaterThanOrEqual(MIN_OPEN_MS);
  });

  it('tears while the eyes are shut — one clock, not two', () => {
    // The sync assertion. If blink and glitch ever drifted apart, this is the frame
    // that would show it: shut eyes over a perfectly still figure, or a tear over
    // open ones.
    const frame = glitchFrameAt(SHUT_MS, false);

    expect(patchOpacityAt(SHUT_MS, false)).toBe(1);
    expect(frame.ghostA.opacity).toBeGreaterThan(0);
    expect(frame.ghostB.opacity).toBeGreaterThan(0);
    expect(frame.scanBoost).toBeGreaterThan(0);

    // And in the second burst of a double, at the same offset.
    const second = glitchFrameAt(DOUBLE_OFFSET_MS + SHUT_MS, true);
    expect(second.ghostA.opacity).toBeGreaterThan(0);
    expect(second).toEqual(frame);
  });

  it('splits the two ghosts in opposite directions, 4-5px apart from centre', () => {
    const frame = glitchFrameAt(SHUT_MS, false);

    expect(frame.ghostA.translateX).toBeGreaterThan(0);
    expect(frame.ghostB.translateX).toBeLessThan(0);
    for (const x of [frame.ghostA.translateX, frame.ghostB.translateX]) {
      expect(Math.abs(x)).toBeGreaterThanOrEqual(4);
      expect(Math.abs(x)).toBeLessThanOrEqual(5);
    }
  });

  it('displaces the slice through three positions, alternating sides', () => {
    const tops = new Set<number>();
    const signs: number[] = [];

    for (const t of [60, 120, 170]) {
      const { slice } = glitchFrameAt(t, false);
      expect(slice.opacity).toBeGreaterThan(0);
      // Never off the figure: the band plus its height has to stay inside the frame.
      expect(slice.top).toBeGreaterThanOrEqual(0);
      expect(slice.top + SLICE_HEIGHT_RATIO).toBeLessThanOrEqual(1);
      tops.add(slice.top);
      signs.push(Math.sign(slice.translateX));
    }

    expect(tops.size).toBe(3);
    expect(signs).toEqual([-1, 1, -1]);
  });

  it('snaps the tracking line from the top of the figure to the bottom', () => {
    const path = [10, 40, 90, 140, 180].map((t) => glitchFrameAt(t, false).track.top);

    expect(path).toEqual([...path].sort((a, b) => a - b));
    expect(path[0]).toBeLessThan(0.2);
    expect(path.at(-1)).toBeGreaterThan(0.8);
  });

  it('keeps the figure jitter inside ±2px', () => {
    for (let t = 0; t <= BURST_MS; t += 1) {
      expect(Math.abs(glitchFrameAt(t, false).jitter)).toBeLessThanOrEqual(2);
    }
  });

  it('is pure — the same instant renders the same frame', () => {
    expect(glitchFrameAt(97, true)).toEqual(glitchFrameAt(97, true));
    // Before the offset a double is INDISTINGUISHABLE from a single — the second
    // burst is what makes them differ, and nothing earlier is allowed to.
    expect(glitchFrameAt(97, true)).toEqual(glitchFrameAt(97, false));
    expect(glitchFrameAt(DOUBLE_OFFSET_MS + SHUT_MS, true)).not.toEqual(
      glitchFrameAt(DOUBLE_OFFSET_MS + SHUT_MS, false),
    );
  });

  it('reads identically at zero whatever `double` says', () => {
    // This is the property `mascot-stage.tsx` leans on when it starts an event: it
    // zeroes the clock BEFORE flipping the flag, because zero is the one instant where
    // the two cannot disagree. If that ever stopped being true, the write order there
    // would go from load-bearing to insufficient — and nothing in the component could
    // tell you.
    expect(glitchFrameAt(0, true)).toEqual(glitchFrameAt(0, false));
    expect(patchOpacityAt(0, true)).toBe(patchOpacityAt(0, false));
  });

  it('clamps outside the event rather than extrapolating', () => {
    expect(patchOpacityAt(-500, false)).toBe(0);
    expect(patchOpacityAt(99_999, true)).toBe(0);
    expect(glitchFrameAt(99_999, false).ghostA.opacity).toBe(0);
  });
});
