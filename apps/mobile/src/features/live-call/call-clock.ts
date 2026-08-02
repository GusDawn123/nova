import { useEffect, useState } from 'react';

import type { LiveStatus } from '@/hooks/use-live-session';

/**
 * The HUD's clock — `◉ LIVE · mm:ss`
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4).
 *
 * Read off the WALL CLOCK rather than counted in ticks. A call is minutes long and
 * the JS thread is throttled the moment the app backgrounds, so a counted timer
 * would quietly under-report the length of the very call it is timing. (The
 * thinking indicator counts, and is right to: it drives a word, not a duration.)
 *
 * Minutes never wrap at an hour — a 74-minute call reads `74:03`, because `14:03`
 * would be a lie about a call the user is still on. Same rule, same reason, as
 * `features/notes/transcript.ts::formatCallClock`.
 */

/** How often the clock re-reads the wall. One second: it displays seconds. */
const CLOCK_TICK_MS = 1000;

/** `mm:ss`, minutes unwrapped, never negative. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The HUD line for a session state.
 *
 * A `Record`-driven switch over the hook's own status union, so a sixth status is a
 * type error here rather than a blank HUD. `◉` is the record glyph and belongs to a
 * live call only; every other state gets the hollow ring.
 */
export function hudLabel(status: LiveStatus, elapsedMs: number): string {
  switch (status) {
    case 'idle':
      return '◌ STANDBY';
    case 'connecting':
      return '◌ CONNECTING';
    case 'live':
      return `◉ LIVE · ${formatElapsed(elapsedMs)}`;
    case 'closed':
      return `◌ ENDED · ${formatElapsed(elapsedMs)}`;
    case 'error':
      return '◌ OFF AIR';
  }
}

export interface CallClock {
  /** Milliseconds since this call went live; frozen once it ends. */
  readonly elapsedMs: number;
  /**
   * Whether THIS attempt ever went live. `closed` and `error` each cover two
   * different things — a call that ended, and a start that never connected — and
   * only the first has a summary worth showing.
   *
   * Per ATTEMPT, not per mount: a failed start that follows a successful call must
   * not inherit the finished call's summary, and this screen stays mounted for the
   * life of the tab.
   */
  readonly ran: boolean;
}

/**
 * The running call clock.
 *
 * @param running the screen's `status === 'live'`.
 * @param attempt bumped by the screen every time START is pressed. It is what makes
 *   `ran` mean "this attempt went live" rather than "some call ran since this screen
 *   mounted" — a tab screen stays mounted for the life of the app, so without it a
 *   start that fails AFTER a good call would inherit that call's summary. A counter
 *   rather than a derived status transition, because a start can fail before it ever
 *   reaches `connecting` (no session, no meeting row) and every one of those paths
 *   has to clear the same state.
 *
 * The resets live in a render-phase adjustment rather than an effect (React's "state
 * that has to change when a prop changes", and the shape `StreamingText` uses): this
 * repo lints `set-state-in-effect` as an error, and doing it in an effect would also
 * paint one frame of the PREVIOUS call's duration on the new one.
 */
export function useCallClock(running: boolean, attempt: number): CallClock {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [phase, setPhase] = useState({ attempt, running, ran: running });

  if (phase.attempt !== attempt || phase.running !== running) {
    const fresh = phase.attempt !== attempt;
    setPhase({
      attempt,
      running,
      // A new attempt starts from nothing; within one attempt, a call that ENDS
      // keeps its `ran` — that is what the ended summary is for.
      ran: fresh ? running : phase.ran || running,
    });
    // Zeroed HERE rather than in the effect below, so the first frame of a new call
    // never shows the length of the last one.
    if (fresh || running) setElapsedMs(0);
  }

  useEffect(() => {
    if (!running) return;

    // The wall is read inside the effect, not during render: `Date.now()` is impure
    // and the render must stay idempotent (react-hooks/purity). A few milliseconds
    // between the state flip and this line are invisible on a clock that shows
    // seconds.
    const startedAt = Date.now();
    const tick = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, CLOCK_TICK_MS);

    return () => {
      clearInterval(tick);
    };
  }, [running, attempt]);

  return { elapsedMs, ran: phase.ran };
}
