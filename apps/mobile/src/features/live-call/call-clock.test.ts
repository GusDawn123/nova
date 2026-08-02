import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatElapsed, hudLabel, useCallClock } from './call-clock';

/**
 * The HUD's clock — `◉ LIVE · mm:ss`.
 *
 * It is read off the wall clock rather than counted in ticks: a call is minutes
 * long, the JS thread is throttled the moment the app backgrounds, and a counted
 * timer would quietly under-report the length of the call it is timing.
 *
 * The three things worth pinning: minutes never wrap (a 74-minute call reads
 * `74:0x`, not `14:0x`), the clock ZEROES for a new call rather than resuming, and
 * `ran` stays true after the call ends — it is what tells "ended" from "never
 * started", which are the same `closed` status on the hook.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formatElapsed', () => {
  it('reads mm:ss from zero', () => {
    expect(formatElapsed(0)).toBe('00:00');
  });

  it('rolls seconds into minutes', () => {
    expect(formatElapsed(65_000)).toBe('01:05');
  });

  it('does not wrap the minutes at an hour', () => {
    expect(formatElapsed(74 * 60_000 + 3_000)).toBe('74:03');
  });

  it('never shows a negative clock', () => {
    expect(formatElapsed(-5_000)).toBe('00:00');
  });
});

describe('hudLabel', () => {
  it('marks a live call with the record glyph and its clock', () => {
    expect(hudLabel('live', 65_000)).toBe('◉ LIVE · 01:05');
  });

  it('says what it is doing before the call is up', () => {
    expect(hudLabel('idle', 0)).toBe('◌ STANDBY');
    expect(hudLabel('connecting', 0)).toBe('◌ CONNECTING');
  });

  it('keeps the length of a call that has ended', () => {
    expect(hudLabel('closed', 65_000)).toBe('◌ ENDED · 01:05');
  });

  it('says the session is off the air when it broke', () => {
    expect(hudLabel('error', 65_000)).toBe('◌ OFF AIR');
  });
});

/** What the screen hands the clock: is it live, and which press are we on. */
interface Attempt {
  running: boolean;
  attempt: number;
}

describe('useCallClock', () => {
  it('counts while the call is live', () => {
    const { result, rerender } = renderHook(
      ({ running, attempt }: Attempt) => useCallClock(running, attempt),
      { initialProps: { running: false, attempt: 0 } },
    );

    rerender({ running: true, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(65_000);
    });

    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(65_000);
    expect(result.current.ran).toBe(true);
  });

  it('holds the final length when the call ends', () => {
    const { result, rerender } = renderHook(
      ({ running, attempt }: Attempt) => useCallClock(running, attempt),
      { initialProps: { running: false, attempt: 0 } },
    );

    rerender({ running: true, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ running: false, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(formatElapsed(result.current.elapsedMs)).toBe('00:30');
    expect(result.current.ran).toBe(true);
  });

  it('zeroes for the next call rather than resuming the last one', () => {
    const { result, rerender } = renderHook(
      ({ running, attempt }: Attempt) => useCallClock(running, attempt),
      { initialProps: { running: false, attempt: 0 } },
    );

    rerender({ running: true, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ running: false, attempt: 1 });
    rerender({ running: true, attempt: 2 });

    expect(result.current.elapsedMs).toBe(0);
  });

  it('has not run before the first call', () => {
    const { result } = renderHook(() => useCallClock(false, 0));

    expect(result.current.ran).toBe(false);
    expect(result.current.elapsedMs).toBe(0);
  });

  it('does not lend a finished call’s history to the next attempt', () => {
    // The failure this pins: the screen is a TAB and stays mounted, so a start that
    // never connects, pressed after a call that did, would otherwise still report a
    // call worth summarising.
    const { result, rerender } = renderHook(
      ({ running, attempt }: Attempt) => useCallClock(running, attempt),
      { initialProps: { running: false, attempt: 0 } },
    );

    rerender({ running: true, attempt: 1 });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ running: false, attempt: 1 });
    expect(result.current.ran).toBe(true);

    // Pressed again; this one never goes live.
    rerender({ running: false, attempt: 2 });

    expect(result.current.ran).toBe(false);
    expect(result.current.elapsedMs).toBe(0);
  });
});
