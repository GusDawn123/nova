import { act, render, screen, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { cobaltPalette } from '@/design/tokens';
import { reanimatedSpies } from '@/testing/reanimated-stub';

import { THINKING_BEAT_MS } from './thinking';
import { THINKING_BARS, ThinkingIndicator } from './thinking-indicator';

/**
 * The thinking indicator — "she narrates while the silhouette forms"
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6).
 *
 * Two things carry the design here. The word is INFORMATION — it is the only thing
 * on screen saying what she is doing — so it keeps advancing under reduced motion
 * even though everything decorating it stops. And the bars are the silhouette of the
 * answer that has not arrived yet: three of them, at the spec's widths, lit by
 * travelling sweeps that reduced motion removes.
 *
 * The exit is deliberately absent from these tests. The parent unmounts this
 * component at handoff and owns the 240ms fade (spec §6); a component that animated
 * its own exit would fight it.
 */
vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * `useReducedMotion` is mocked rather than driven through `AccessibilityInfo`: the
 * real store caches its value for the life of the module by design (see `motion.ts`),
 * so a test that flipped the OS setting would leak into every test after it. One mock
 * covers `LightSweep` too — it reads the same module.
 */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

/**
 * jsdom has no layout engine and no `ResizeObserver`, so react-native-web's
 * `onLayout` never fires on its own and the sweeps inside the bars would sit forever
 * at their unmeasured state — drawing nothing, and passing every reduced-motion
 * assertion below vacuously. Same stubs as `design/light-sweep.test.tsx`.
 */
class StubResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.targets.add(target);
    this.callback(
      [...this.targets].map((t) => ({ target: t }) as ResizeObserverEntry),
      this,
    );
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }
}

beforeAll(() => {
  // react-native-web caches ONE observer the first time a view asks for it, so this
  // has to be in place before the first render in the file.
  globalThis.ResizeObserver = StubResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 200,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 4,
  });
});

beforeEach(() => {
  reduced.value = false;
  reanimatedSpies.withRepeat.mockClear();
  reanimatedSpies.withSequence.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const INK = cobaltPalette.ink;
const FILL = cobaltPalette.inkFill;

function renderIndicator(): void {
  render(<ThinkingIndicator color={INK} fillColor={FILL} />);
}

/** What the reader would actually see. */
function word(): string {
  return screen.getByTestId('thinking-word').textContent ?? '';
}

/** Run the cadence forward and let React flush what it produced. */
function advanceBeats(count: number): void {
  act(() => {
    vi.advanceTimersByTime(count * THINKING_BEAT_MS);
  });
}

describe('ThinkingIndicator — the silhouette', () => {
  it('draws three bars at the spec widths', () => {
    renderIndicator();

    const bars = screen.getAllByTestId('thinking-bar');
    expect(bars).toHaveLength(3);
    expect(bars.map((bar) => getComputedStyle(bar).width)).toEqual([
      '92%',
      '78%',
      '45%',
    ]);
  });

  it('fills the bars in the colour it was handed and paints the word in the ink', () => {
    renderIndicator();

    for (const bar of screen.getAllByTestId('thinking-bar')) {
      expect(getComputedStyle(bar).backgroundColor).toBe(
        'rgba(255, 255, 255, 0.1)',
      );
    }
    expect(getComputedStyle(screen.getByTestId('thinking-word')).color).toBe(
      'rgb(255, 255, 255)',
    );
  });

  it('runs one light sweep per bar', async () => {
    renderIndicator();

    await waitFor(() => {
      expect(screen.getAllByTestId('light-sweep-band')).toHaveLength(3);
    });
    expect(reanimatedSpies.withRepeat).toHaveBeenCalledTimes(3);
  });

  it('gives every bar its own sweep period', () => {
    // Three bands crossing together read as one bar cut into three pieces rather
    // than as three things working. Distinct periods drift them apart and keep them
    // apart, where a shared period with a one-off offset re-synchronises.
    const periods = THINKING_BARS.map((bar) => bar.sweepMs);
    expect(new Set(periods).size).toBe(THINKING_BARS.length);
  });
});

describe('ThinkingIndicator — the cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('opens on LISTENING and walks the arc', () => {
    renderIndicator();
    expect(word()).toBe('LISTENING');

    advanceBeats(1);
    expect(word()).toBe('READING THE MOMENT');

    advanceBeats(1);
    expect(word()).toBe('COMPOSING');
  });

  it('holds the last word a beat, then goes round again', () => {
    renderIndicator();

    advanceBeats(3);
    expect(word()).toBe('COMPOSING');
    advanceBeats(1);
    expect(word()).toBe('LISTENING');
    advanceBeats(1);
    expect(word()).toBe('READING THE MOMENT');
  });

  it('flicks the word on every swap', () => {
    renderIndicator();
    const onMount = reanimatedSpies.withSequence.mock.calls.length;

    advanceBeats(1);

    expect(reanimatedSpies.withSequence.mock.calls.length).toBeGreaterThan(
      onMount,
    );
  });

  it('leaves no beat running when it unmounts', () => {
    const { unmount } = render(
      <ThinkingIndicator color={INK} fillColor={FILL} />,
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    // A raw count is the wrong question: react-native-web leaves its own layout
    // timeouts behind either way. A leaked `setInterval` RE-ARMS itself, so draining
    // every pending timer terminates only if the beat is actually gone — with it
    // still running, this aborts at the runner's 10k-timer limit and throws.
    act(() => {
      vi.runAllTimers();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ThinkingIndicator — reduced motion', () => {
  it('keeps narrating with nothing moving', () => {
    // The word is the ONLY thing on screen saying what she is doing, so it is
    // information rather than decoration and it survives the setting. Everything
    // decorating it — the flick, the sweeps — does not.
    reduced.value = true;
    vi.useFakeTimers();

    renderIndicator();
    expect(word()).toBe('LISTENING');
    expect(screen.getAllByTestId('thinking-bar')).toHaveLength(3);

    advanceBeats(1);
    expect(word()).toBe('READING THE MOMENT');
    advanceBeats(1);
    expect(word()).toBe('COMPOSING');

    // No flick on the two swaps that just happened, and no sweep loop at all.
    expect(reanimatedSpies.withSequence).not.toHaveBeenCalled();
    expect(reanimatedSpies.withRepeat).not.toHaveBeenCalled();
  });

  it('removes the travelling bands rather than parking them mid-track', async () => {
    reduced.value = true;

    renderIndicator();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A stopped highlight parked at 40% reads as a stalled progress bar, which is a
    // claim this indicator cannot back up.
    expect(screen.queryByTestId('light-sweep-band')).toBeNull();
    expect(screen.getAllByTestId('thinking-bar')).toHaveLength(3);
  });
});
