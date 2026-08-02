/**
 * The hologram tear — one timeline, sampled
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7; intensity approved from
 * the `mascot-alive-v2.html` demo).
 *
 * ---------------------------------------------------------------------------
 * Why this is arithmetic and not five animations
 * ---------------------------------------------------------------------------
 * The spec's hard requirement is that the blink and the glitch "cannot drift". Five
 * `withSequence` chains started in the same frame will hold together for a while and
 * then, on a dropped frame or a re-entered event, will not — and the failure looks
 * like her eyes closing a beat after the tear, which reads as a bug rather than as a
 * projection.
 *
 * So there is ONE animated value in `mascot-stage.tsx`: elapsed milliseconds, ramped
 * linearly across the event. Every channel here is a pure function of that number.
 * Drift is not unlikely — it is unrepresentable.
 *
 * These functions run ON THE UI THREAD, hence the `'worklet'` directives. They are
 * also ordinary functions on the JS thread, which is what lets the whole timeline be
 * tested as arithmetic with no renderer involved.
 *
 * ---------------------------------------------------------------------------
 * The double blink
 * ---------------------------------------------------------------------------
 * A double is not a second timeline — it is the SAME burst re-entered
 * {@link DOUBLE_OFFSET_MS} later. {@link burstTime} does the whole of it: before the
 * offset you are in burst one, after it you are at the same place in burst two. The
 * offset is longer than a burst, so the first tear finishes and the figure is
 * genuinely still for a beat before the second one starts — two blinks, not one long
 * one. What that beat costs is the whole of {@link DOUBLE_OFFSET_MS}'s reasoning below.
 */

/** One blink-plus-tear burst. Spec §7: "~200ms". */
export const BURST_MS = 200;

/**
 * A double blink's second close starts this long after the first — measured
 * start-to-start, so the eyes are open for `240 − 164 = 76ms` in between.
 *
 * That open window is the number that matters, and it is the whole reason this is 240
 * rather than the 180 the plan named. At 180 the eyes reopen for 16ms — ONE FRAME at
 * 60Hz — which no one perceives as a second blink; it reads as a single close that
 * stuttered. 76ms is about five frames: unmistakably two.
 *
 * Taken from `mascot-alive-v2.html`, the ratified demo, whose double window is ~243ms
 * start-to-start. The demo is the design authority here, not the plan's constant.
 */
export const DOUBLE_OFFSET_MS = 240;

/** The cross-fade in and out of the closed patch. Fast enough to read as a snap. */
const PATCH_FADE_MS = 24;

/**
 * Midpoint-to-midpoint length of one close — the spec's "~140ms". The fade edges sit
 * outside this, so the patch is fully opaque from {@link PATCH_FADE_MS} to here.
 */
const PATCH_CLOSE_MS = 140;

/** The displaced band's height, as a fraction of the figure. */
export const SLICE_HEIGHT_RATIO = 0.09;

/** The band's opacity while it is showing. It is a hard cut, not a fade. */
const SLICE_OPACITY = 0.9;

/**
 * A keyframe track: `[timeMs, value]` pairs in ascending time, read with linear
 * interpolation between them and clamped at both ends. The CSS `@keyframes` the demo
 * was approved from behave the same way, so these numbers transfer directly.
 */
type Track = readonly (readonly [number, number])[];

const PATCH_OPACITY: Track = [
  [0, 0],
  [PATCH_FADE_MS, 1],
  [PATCH_CLOSE_MS, 1],
  [PATCH_CLOSE_MS + PATCH_FADE_MS, 0],
  [BURST_MS, 0],
];

// The two echoes split in opposite directions and breathe against each other inside
// the spec's ±4-5px, then kick back the other way as the tear collapses.
const GHOST_A_OPACITY: Track = [
  [0, 0],
  [30, 0.55],
  [105, 0.55],
  [155, 0.3],
  [BURST_MS, 0],
];
const GHOST_A_X: Track = [
  [0, 0],
  [30, 5],
  [105, 4],
  [155, -2],
  [BURST_MS, 0],
];
const GHOST_B_OPACITY: Track = [
  [0, 0],
  [30, 0.5],
  [105, 0.5],
  [155, 0.25],
  [BURST_MS, 0],
];
const GHOST_B_X: Track = [
  [0, 0],
  [30, -4],
  [105, -5],
  [155, 2],
  [BURST_MS, 0],
];

const TRACK_OPACITY: Track = [
  [0, 0],
  [25, 0.85],
  [110, 0.7],
  [185, 0],
  [BURST_MS, 0],
];
/** Top of the tracking line as a fraction of the figure: it snaps down and off. */
const TRACK_TOP: Track = [
  [0, 0.08],
  [25, 0.14],
  [110, 0.58],
  [185, 0.9],
  [BURST_MS, 0.9],
];

/** Spec §7: "the figure jitters ±2px". */
const JITTER_X: Track = [
  [0, 0],
  [35, 1.5],
  [100, -1.5],
  [160, 2],
  [BURST_MS, 0],
];

/** 0-1 extra scanline strength — spec §7's "scanlines double". */
const SCAN_BOOST: Track = [
  [0, 0],
  [35, 1],
  [150, 1],
  [BURST_MS, 0],
];

/**
 * The slice STEPS rather than slides: three hard positions, alternating sides. A band
 * that travelled smoothly would read as an object moving across her; a band that
 * jumps reads as a frame the projector got wrong, which is the effect being bought.
 */
const SLICE_STEPS = [
  { from: 30, to: 90, top: 0.24, translateX: -7 },
  { from: 90, to: 150, top: 0.58, translateX: 6 },
  { from: 150, to: 190, top: 0.38, translateX: -4 },
] as const;

/** Every glitch channel at one instant. `top` values are fractions of the figure. */
export interface GlitchFrame {
  ghostA: { opacity: number; translateX: number };
  ghostB: { opacity: number; translateX: number };
  slice: { opacity: number; top: number; translateX: number };
  track: { opacity: number; top: number };
  /** Horizontal jitter of the whole figure, in points. */
  jitter: number;
  /** 0-1: how much to add to the resting scanline strength. */
  scanBoost: number;
}

/** Where the band rests when it is not showing. Invisible, so only its opacity matters. */
const SLICE_REST: GlitchFrame['slice'] = {
  opacity: 0,
  top: SLICE_STEPS[0].top,
  translateX: 0,
};

/** Linear read of a keyframe track, clamped outside its range. */
function sample(track: Track, t: number): number {
  'worklet';
  const first = track[0];
  const last = track[track.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (t <= first[0]) return first[1];
  if (t >= last[0]) return last[1];

  for (let i = 1; i < track.length; i += 1) {
    const previous = track[i - 1];
    const next = track[i];
    if (previous === undefined || next === undefined) continue;
    if (t <= next[0]) {
      const span = next[0] - previous[0];
      // Two keyframes at the same instant is a hard cut, not a division by zero.
      if (span <= 0) return next[1];
      return previous[1] + ((next[1] - previous[1]) * (t - previous[0])) / span;
    }
  }

  return last[1];
}

/**
 * Where in a single burst the event's elapsed time lands.
 *
 * This is the entire implementation of the double blink, and the reason blink and
 * glitch cannot separate: both read it, from the same number, in the same frame.
 */
function burstTime(elapsedMs: number, double: boolean): number {
  'worklet';
  const t = double && elapsedMs >= DOUBLE_OFFSET_MS ? elapsedMs - DOUBLE_OFFSET_MS : elapsedMs;
  if (t < 0) return 0;
  if (t > BURST_MS) return BURST_MS;
  return t;
}

/** How long the stage's one animated value ramps for. */
export function eventDurationMs(double: boolean): number {
  'worklet';
  return double ? DOUBLE_OFFSET_MS + BURST_MS : BURST_MS;
}

/** Opacity of the closed-eyes patch. 0 = her open eyes show through untouched. */
export function patchOpacityAt(elapsedMs: number, double: boolean): number {
  'worklet';
  return sample(PATCH_OPACITY, burstTime(elapsedMs, double));
}

export function glitchFrameAt(elapsedMs: number, double: boolean): GlitchFrame {
  'worklet';
  const t = burstTime(elapsedMs, double);

  let slice = SLICE_REST;
  for (let i = 0; i < SLICE_STEPS.length; i += 1) {
    const step = SLICE_STEPS[i];
    if (step !== undefined && t >= step.from && t < step.to) {
      slice = { opacity: SLICE_OPACITY, top: step.top, translateX: step.translateX };
    }
  }

  return {
    ghostA: { opacity: sample(GHOST_A_OPACITY, t), translateX: sample(GHOST_A_X, t) },
    ghostB: { opacity: sample(GHOST_B_OPACITY, t), translateX: sample(GHOST_B_X, t) },
    slice,
    track: { opacity: sample(TRACK_OPACITY, t), top: sample(TRACK_TOP, t) },
    jitter: sample(JITTER_X, t),
    scanBoost: sample(SCAN_BOOST, t),
  };
}
