/**
 * The stream drain (spec §6 "Text arrival — CRISP TERMINAL").
 *
 * Socket tokens do NOT arrive at reading speed. The conductor coalesces deltas into
 * ~50ms batches, so a suggestion lands as a handful of lumps — twenty characters,
 * nothing, sixty characters. Rendered as they arrive that reads as stuttering paste,
 * not as someone writing, and the block caret (which IS the completion signal) would
 * teleport instead of riding a write-head.
 *
 * So this is the smoothing buffer between the socket and the screen: bursts in,
 * steady flow out at ~60 chars/sec, accelerating gently when the buffer backs up so
 * a long answer never falls minutes behind the speaker. It is PURE — no React, no
 * timers of its own beyond the injected `schedule`, no knowledge of what renders the
 * characters — which is what makes the cadence testable under fake timers instead of
 * eyeballed on a device.
 */

/** Tick interval — one animation frame at 60Hz, the finest cadence worth drawing. */
const TICK_MS = 16;

/**
 * Ceiling on the elapsed time one tick may bill for.
 *
 * Ticks are `setTimeout`, and a busy RN JS thread delays them: after a 500ms stall an
 * unclamped tick would bill 500ms of characters and dump ~90 of them in one frame —
 * exactly the paste-artifact this module exists to prevent. Clamping makes a stalled
 * tick emit a normal-sized chunk and leaves the rest in the buffer, where the
 * catch-up curve below absorbs it over the next few frames.
 */
const MAX_TICK_DT_MS = TICK_MS * 4;

/** Buffer depth (in characters) that buys one full multiple of the base rate. */
const CATCHUP_CHARS = 80;

/** Hard ceiling on catch-up: 3x base (~180cps), still legible as writing. */
const CATCHUP_MAX_MULTIPLE = 2;

/**
 * Nudge a cut point off the seam of a surrogate pair.
 *
 * `slice` counts UTF-16 code units, and at the base rate a tick emits exactly ONE of
 * them — so every emoji in an answer would be split down the middle and spend a frame
 * on screen as a lone half-character (a `�` box) before its other half arrived. Not a
 * rare race: at one unit per tick it happens to every pair, every time.
 *
 * Only the seam INSIDE the buffer is ours to fix. A delta that arrives already ending
 * mid-pair is the transport's problem — holding the orphan back would stall the drain
 * on a stream that may never send the other half.
 */
function wholeCharacters(text: string, cut: number): number {
  if (cut >= text.length) return cut;
  const last = text.charCodeAt(cut - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;

  return isHighSurrogate ? cut + 1 : cut;
}

export interface StreamDrain {
  push(text: string): void; // socket tokens land here, any size
  end(): void; // no more input; onDone fires when buffer empties
  dispose(): void; // cancel timers
}

export interface StreamDrainOptions {
  onText(chunk: string): void; // drained characters, 1-3 per tick
  onDone(): void;
  baseCps?: number; // default 60
  now?: () => number; // injectable clock for tests
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

export function createStreamDrain(opts: StreamDrainOptions): StreamDrain {
  const {
    onText,
    onDone,
    baseCps = 60,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
  } = opts;

  let buffer = '';
  let ended = false;
  let disposed = false;
  let doneFired = false;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let lastTickAt = now();

  /**
   * Arm the next tick, unless one is already in flight. Re-stamping `lastTickAt` here
   * is what makes an arm-after-idle safe: the drain sleeps between suggestions (no
   * timer at all while the buffer is empty), and without this stamp the first tick
   * after a ten-second silence would bill ten seconds of characters.
   */
  function arm(): void {
    if (disposed || handle !== null) return;
    lastTickAt = now();
    handle = schedule(tick, TICK_MS);
  }

  function finish(): void {
    if (doneFired) return;
    doneFired = true;
    onDone();
  }

  function tick(): void {
    handle = null;
    if (disposed) return;

    const at = now();
    const dtMs = Math.min(Math.max(at - lastTickAt, 0), MAX_TICK_DT_MS);
    lastTickAt = at;

    if (buffer.length > 0) {
      const cps =
        baseCps *
        (1 + Math.min(buffer.length / CATCHUP_CHARS, CATCHUP_MAX_MULTIPLE));
      // `max(1, …)` guarantees forward progress: rounding a sub-character tick to
      // zero would stall the stream forever at low rates.
      const n = wholeCharacters(
        buffer,
        Math.max(1, Math.round((cps * dtMs) / 1000)),
      );
      const chunk = buffer.slice(0, n);
      buffer = buffer.slice(n);
      onText(chunk);
      // onText is the consumer's setState; a React unmount can dispose us from
      // inside it, so nothing below may assume we are still alive.
      if (disposed) return;
    }

    if (buffer.length > 0) {
      arm();
      return;
    }
    if (ended) {
      finish();
      return;
    }
    // Buffer empty, more input expected: sleep. `push` re-arms.
  }

  return {
    push(text: string): void {
      // CONSTRAINT — input after `end()` is DROPPED, not thrown.
      //
      // `end()` is the caller's promise that nothing more is coming, so a later push
      // is a bug on the caller's side either way. Throwing would surface it loudly,
      // but the caller is a React effect diffing a growing `text` prop against a
      // `done` prop, and the two can legitimately land in the same commit or out of
      // order across a reconnect — so throwing would take down a live call over an
      // ordering race. Dropping also protects the spec's single completion signal:
      // once the caret has vanished, no text may appear after it.
      if (disposed || ended) return;
      // An empty push carries no work and must not arm a tick, or an idle drain
      // would spin one no-op frame per empty delta.
      if (text.length === 0) return;
      buffer += text;
      arm();
    },

    end(): void {
      if (disposed || ended) return;
      ended = true;
      // Always arm, even on an empty buffer: `onDone` then fires from a tick rather
      // than synchronously inside `end()`, so the consumer's completion handler never
      // re-enters React from inside its own effect.
      arm();
    },

    dispose(): void {
      disposed = true;
      buffer = '';
      if (handle !== null) {
        // `schedule` is typed to return a `setTimeout` handle precisely so this can
        // cancel it. A custom scheduler whose handle `clearTimeout` cannot cancel is
        // still safe: the `disposed` guard makes any stray tick a no-op.
        clearTimeout(handle);
        handle = null;
      }
      // Deliberately no `onDone` — dispose is a cancellation, not a completion.
    },
  };
}
