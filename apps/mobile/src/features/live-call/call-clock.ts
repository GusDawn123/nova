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
   * Whether a call has run in this mount. `closed` covers both "the call ended" and
   * "start was pressed and nothing ever connected", and only the first of those has
   * a summary worth showing.
   */
  readonly ran: boolean;
}

/**
 * The running call clock. `running` is the screen's `status === 'live'`.
 *
 * The reset lives in a render-phase adjustment rather than an effect (React's
 * "state that has to change when a prop changes", and the shape `StreamingText`
 * uses): this repo lints `set-state-in-effect` as an error, and doing it in an
 * effect would also paint one frame of the PREVIOUS call's duration on the new one.
 */
export function useCallClock(running: boolean): CallClock {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [phase, setPhase] = useState(() => ({
    running,
    startedAt: running ? Date.now() : null,
    ran: running,
  }));

  if (phase.running !== running) {
    setPhase({
      running,
      // A call that ENDS keeps its start, so the frozen clock still reads the length
      // of what just happened.
      startedAt: running ? Date.now() : phase.startedAt,
      ran: phase.ran || running,
    });
    if (running) setElapsedMs(0);
  }

  const { startedAt } = phase;

  useEffect(() => {
    if (!running || startedAt === null) return;

    const tick = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, CLOCK_TICK_MS);

    return () => {
      clearInterval(tick);
    };
  }, [running, startedAt]);

  return { elapsedMs, ran: phase.ran };
}
