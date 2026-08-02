import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStreamDrain, type StreamDrain } from './drain';

describe('createStreamDrain', () => {
  // Here rather than at the end of each test body: a failed assertion skips the
  // lines after it, and fake timers left installed leak into every test that follows.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains a burst at a steady character rate, not all at once', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {},
    });
    d.push('Honestly, because the problems');
    vi.advanceTimersByTime(50);
    const after50 = out.join('').length;
    expect(after50).toBeGreaterThan(0);
    expect(after50).toBeLessThan(10); // ~60cps → ~3 chars in 50ms, never the whole burst
    vi.advanceTimersByTime(2000);
    expect(out.join('')).toBe('Honestly, because the problems');
    d.dispose();
    vi.useRealTimers();
  });

  it('accelerates when the buffer backs up (catch-up)', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {},
    });
    d.push('x'.repeat(400)); // deep backlog
    vi.advanceTimersByTime(1000);
    expect(out.join('').length).toBeGreaterThan(90); // faster than base 60cps
    d.dispose();
    vi.useRealTimers();
  });

  it('onDone fires only after end() AND an empty buffer', () => {
    vi.useFakeTimers();
    let done = false;
    const d = createStreamDrain({
      onText: () => {},
      onDone: () => {
        done = true;
      },
    });
    d.push('abc');
    d.end();
    expect(done).toBe(false);
    vi.advanceTimersByTime(500);
    expect(done).toBe(true);
    d.dispose();
    vi.useRealTimers();
  });
});

/**
 * The cases above pin the cadence. These pin the lifecycle — the places where a
 * character-level timer loop that outlives its consumer does real damage: a timer
 * that survives unmount, a completion signal that fires twice (or after the caret
 * already vanished), a tick that bills a ten-second idle gap as ten seconds of text.
 */
describe('createStreamDrain lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits 1-3 characters per tick even at maximum catch-up', () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const d = createStreamDrain({
      onText: (c) => chunks.push(c),
      onDone: () => {},
    });

    d.push('x'.repeat(400)); // pinned at the 3x ceiling for the whole window
    vi.advanceTimersByTime(1000);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(1);
      expect(chunk.length).toBeLessThanOrEqual(3);
    }
    d.dispose();
  });

  it('stops emitting and cancels its timer on dispose mid-drain', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    let done = false;
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {
        done = true;
      },
    });

    d.push('x'.repeat(200));
    vi.advanceTimersByTime(100);
    const drainedAtDispose = out.join('').length;
    expect(drainedAtDispose).toBeGreaterThan(0);

    d.dispose();
    expect(vi.getTimerCount()).toBe(0); // no orphan timer survives unmount
    vi.advanceTimersByTime(5000);

    expect(out.join('').length).toBe(drainedAtDispose);
    expect(done).toBe(false); // dispose is a cancellation, never a completion
  });

  it('survives a dispose performed from inside onText', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    let done = false;
    // The real consumer's onText is a setState; a React unmount can dispose the
    // drain from inside that call.
    const d: StreamDrain = createStreamDrain({
      onText: (c) => {
        out.push(c);
        d.dispose();
      },
      onDone: () => {
        done = true;
      },
    });

    d.push('abcdef');
    d.end();
    expect(() => {
      vi.advanceTimersByTime(1000);
    }).not.toThrow();

    expect(out.length).toBe(1);
    expect(done).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops input pushed after end() rather than throwing', () => {
    // Documented choice (see drain.ts): a late push is a caller bug, but throwing
    // would take down a live call over a benign ordering race — and text appearing
    // after the caret vanished would contradict the completion signal itself.
    vi.useFakeTimers();
    const out: string[] = [];
    let done = false;
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {
        done = true;
      },
    });

    d.push('abc');
    d.end();
    expect(() => {
      d.push('LATE');
    }).not.toThrow();
    vi.advanceTimersByTime(500);

    expect(out.join('')).toBe('abc');
    expect(done).toBe(true);
    d.dispose();
  });

  it('fires onDone exactly once, however many times end() is called', () => {
    vi.useFakeTimers();
    let doneCount = 0;
    const d = createStreamDrain({
      onText: () => {},
      onDone: () => {
        doneCount += 1;
      },
    });

    d.push('abc');
    d.end();
    d.end();
    vi.advanceTimersByTime(500);
    d.end();
    vi.advanceTimersByTime(500);

    expect(doneCount).toBe(1);
    d.dispose();
  });

  it('fires onDone once even when end() is called from inside onText', () => {
    // The re-entrant path: a consumer that ends the stream the moment the drained
    // text is complete calls end() from inside the tick that emptied the buffer.
    // That arms a fresh tick AND lets the running one reach the empty-and-ended
    // state, so two ticks arrive there. Only the latch keeps the caret from being
    // told to vanish twice.
    vi.useFakeTimers();
    const text = 'abc';
    let drained = '';
    let doneCount = 0;
    const d: StreamDrain = createStreamDrain({
      onText: (c) => {
        drained += c;
        if (drained === text) d.end();
      },
      onDone: () => {
        doneCount += 1;
      },
    });

    d.push(text);
    vi.advanceTimersByTime(500);

    expect(drained).toBe(text);
    expect(doneCount).toBe(1);
    d.dispose();
  });

  it('keeps making progress at a rate too slow to fill one tick', () => {
    // Below ~31cps a tick's share rounds to zero characters, and a drain that emits
    // nothing never empties, never completes, and leaves the caret up forever.
    vi.useFakeTimers();
    const out: string[] = [];
    let done = false;
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {
        done = true;
      },
      baseCps: 20,
    });

    d.push('abc');
    d.end();
    vi.advanceTimersByTime(5000);

    expect(out.join('')).toBe('abc');
    expect(done).toBe(true);
    d.dispose();
  });

  it('runs one tick loop however many pushes arrive mid-drain', () => {
    // Bursts land while a tick is already in flight. Arming per push would run two
    // or three loops over the same buffer — double rate, and a timer per burst
    // outliving the stream.
    vi.useFakeTimers();
    const out: string[] = [];
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {},
    });

    d.push('x'.repeat(100));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(8); // mid-tick
    d.push('y'.repeat(150));
    d.push('z'.repeat(150));
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    // One loop at the 3x ceiling drains at most 3 chars per 16ms tick.
    expect(out.join('').length).toBeLessThanOrEqual(3 * Math.ceil(1008 / 16));
    d.dispose();
  });

  it('completes on end() even when nothing was ever pushed', () => {
    vi.useFakeTimers();
    let done = false;
    const d = createStreamDrain({
      onText: () => {},
      onDone: () => {
        done = true;
      },
    });

    d.end();
    // Asynchronously: onDone must not re-enter the consumer from inside its own
    // end() call.
    expect(done).toBe(false);
    vi.advanceTimersByTime(100);

    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    d.dispose();
  });

  it('treats an empty push as no work at all', () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const d = createStreamDrain({
      onText: (c) => chunks.push(c),
      onDone: () => {},
    });

    d.push('');
    expect(vi.getTimerCount()).toBe(0); // no tick armed for zero characters
    vi.advanceTimersByTime(100);
    expect(chunks).toEqual([]); // and never an empty chunk downstream

    // …and it leaves the rate maths untouched for the push that follows.
    d.push('');
    d.push('Honestly, because the problems');
    vi.advanceTimersByTime(50);
    expect(chunks.join('').length).toBeGreaterThan(0);
    expect(chunks.join('').length).toBeLessThan(10);
    d.dispose();
  });

  it('does not dump the backlog when a push arrives after a long idle gap', () => {
    // The drain sleeps with no timer while the buffer is empty, so the first tick
    // after a silence must bill one tick — not the whole gap.
    vi.useFakeTimers();
    const out: string[] = [];
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {},
    });

    d.push('abc');
    vi.advanceTimersByTime(500);
    expect(out.join('')).toBe('abc');
    expect(vi.getTimerCount()).toBe(0); // idle: nothing scheduled

    vi.advanceTimersByTime(10_000); // ten seconds of silence between suggestions
    out.length = 0;
    d.push('Honestly, because the problems');
    vi.advanceTimersByTime(20);

    expect(out.join('').length).toBeGreaterThan(0);
    expect(out.join('').length).toBeLessThanOrEqual(2);
    d.dispose();
  });

  it('does not dump the backlog when a tick lands late on a stalled thread', () => {
    // setTimeout is a floor, not a promise. A busy RN JS thread delivers a 16ms tick
    // half a second later, and billing that gap in full would paste ~90 characters
    // into one frame — the artifact the whole module exists to prevent.
    const clock = stalledClock();
    const out: string[] = [];
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {},
      now: clock.now,
      schedule: clock.schedule,
    });

    d.push('x'.repeat(400)); // catch-up pinned at 3x, so 180cps
    clock.fireLate(500);

    expect(out.length).toBe(1);
    // 500ms unclamped would be ~90 characters; the clamp bills four ticks at most.
    expect(out[0].length).toBeLessThanOrEqual(12);
    d.dispose();
  });

  it('never shows half of a character on its way past', () => {
    // A tick emits one UTF-16 code unit at the base rate, so an unguarded slice
    // splits every emoji and puts a `�` on screen for a frame.
    vi.useFakeTimers();
    const text = 'Ask for the raise 👍 — worth 🎯 it.';
    // COLLECT, then assert. An `expect` inside the callback throws into the drain's
    // own timer, where the failure is swallowed and the test reports whatever the
    // final string happens to be.
    const chunks: string[] = [];
    const d = createStreamDrain({
      onText: (c) => chunks.push(c),
      onDone: () => {},
    });

    d.push(text);
    vi.advanceTimersByTime(5000);

    // The premise: the text really was split, so the guard had something to guard.
    expect(chunks.length).toBeGreaterThan(1);
    let drained = '';
    for (const chunk of chunks) {
      expect(hasLoneSurrogate(chunk)).toBe(false);
      drained += chunk;
      expect(hasLoneSurrogate(drained)).toBe(false);
    }
    expect(drained).toBe(text);
    d.dispose();
  });

  it('preserves order and loses nothing across interleaved pushes', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {},
    });

    const pieces = ['Honestly, ', 'because ', 'the problems ', 'were the same.'];
    for (const piece of pieces) {
      d.push(piece);
      vi.advanceTimersByTime(37); // mid-tick, so pushes land between frames
    }
    d.end();
    vi.advanceTimersByTime(5000);

    expect(out.join('')).toBe(pieces.join(''));
    d.dispose();
  });

  it('honours baseCps', () => {
    vi.useFakeTimers();
    const fast: string[] = [];
    const slow: string[] = [];
    const text = 'x'.repeat(100);
    const quick = createStreamDrain({
      onText: (c) => fast.push(c),
      onDone: () => {},
      baseCps: 1000,
    });
    const normal = createStreamDrain({
      onText: (c) => slow.push(c),
      onDone: () => {},
    });

    quick.push(text);
    normal.push(text);
    vi.advanceTimersByTime(120);

    expect(fast.join('')).toBe(text);
    expect(slow.join('').length).toBeLessThan(text.length);
    quick.dispose();
    normal.dispose();
  });

  it('uses the injected clock and scheduler instead of global timers', () => {
    // The whole point of the seam: a consumer test (or a native driver) can own time
    // completely, and nothing leaks onto the global timer queue.
    vi.useFakeTimers();
    const clock = manualClock();
    const out: string[] = [];
    let done = false;
    const d = createStreamDrain({
      onText: (c) => out.push(c),
      onDone: () => {
        done = true;
      },
      now: clock.now,
      schedule: clock.schedule,
    });

    d.push('Honestly, because the problems');
    d.end();
    expect(vi.getTimerCount()).toBe(0); // nothing global was armed

    clock.advance(2000);

    expect(out.join('')).toBe('Honestly, because the problems');
    expect(done).toBe(true);
    expect(clock.pending()).toBe(0); // and the loop stopped scheduling itself
    d.dispose();
  });
});

/**
 * True when `text` holds a surrogate that lost its partner — the code-unit-level
 * damage that renders as `�`. Written out rather than using `isWellFormed()`, which
 * needs a newer lib than the Expo tsconfig targets.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return true; // low half, no high before it
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // a whole pair — step over its second half
    }
  }

  return false;
}

/** A clock whose ticks can be delivered LATE, the way a busy JS thread delivers them. */
function stalledClock(): {
  now: () => number;
  schedule: (fn: () => void) => ReturnType<typeof setTimeout>;
  fireLate: (ms: number) => void;
} {
  let t = 0;
  const queue: (() => void)[] = [];

  return {
    now: () => t,
    schedule: (fn) => {
      queue.push(fn);
      return { manual: true } as unknown as ReturnType<typeof setTimeout>;
    },
    fireLate: (ms) => {
      t += ms;
      const due = queue.shift();
      if (due !== undefined) due();
    },
  };
}

/** A hand-cranked clock + scheduler pair, to prove the drain touches neither global. */
function manualClock(): {
  now: () => number;
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let t = 0;
  let queue: { at: number; fn: () => void }[] = [];

  return {
    now: () => t,
    schedule: (fn, ms) => {
      queue.push({ at: t + ms, fn });
      // A handle `clearTimeout` cannot cancel — deliberately, so the disposed guard
      // is what has to do the work here.
      return { manual: true } as unknown as ReturnType<typeof setTimeout>;
    },
    advance: (ms) => {
      const target = t + ms;
      for (;;) {
        const due = queue
          .filter((entry) => entry.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        queue = queue.filter((entry) => entry !== due);
        t = due.at;
        due.fn();
      }
      t = target;
    },
    pending: () => queue.length,
  };
}
