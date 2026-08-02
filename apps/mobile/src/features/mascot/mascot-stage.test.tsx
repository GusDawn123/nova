import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cobaltPalette } from '@/design/tokens';
import { normaliseColor } from '@/testing/duotone';
import { reanimatedSpies } from '@/testing/reanimated-stub';

import { MascotStage } from './mascot-stage';

/**
 * The mascot stage
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §7 — "she is a hologram").
 *
 * Three things carry the design and are the only things worth pinning here.
 *
 * ONE — the eye patch. Task 8 spent its whole budget finding a crop whose edges lie
 * where the two drawings agree, precisely so no rectangle appears around her eyes
 * mid-fade. That work is thrown away by a full-frame swap, and thrown away just as
 * completely by an overlay placed a few percent off. So the position is asserted
 * against the contract's own numbers, and `eyes-closed.png` is asserted to be absent
 * from the tree entirely.
 *
 * TWO — reduced motion leaves her STILL, not stopped: eyes open, scanlines riding
 * her, and no ghost, slice, tracking line or repeating animation anywhere.
 *
 * THREE — the blink clock is a chain of timers, and a chain that outlives its
 * component is a leak that fires into an unmounted tree.
 *
 * What is NOT proven here: that any of it moves. Reanimated cannot render under
 * vitest (see `testing/reanimated-stub.ts`), so every animated style is evaluated at
 * its resting value. The timeline underneath is covered as arithmetic in
 * `mascot-glitch.test.ts`; that she reads as alive is a simulator check.
 */
vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * `expo-image` is a native module. The stub keeps the two things the assertions need —
 * the `testID` and which file was asked for — and drops everything else. Under vite an
 * image import resolves to its path, so `source` arrives as a readable string.
 */
/**
 * `contentFit` reaches no DOM attribute and no style, so it is RECORDED here by
 * testID. `fill` versus `contain` on the eye patch is the difference between a
 * registered blink and a letterboxed rectangle hung over her face — invisible in
 * jsdom, and until this map, silently deletable.
 */
const contentFits = vi.hoisted(() => new Map<string, string>());

vi.mock('expo-image', async () => {
  const { View } = await import('react-native');
  return {
    Image: ({
      source,
      style,
      tintColor,
      contentFit,
      testID,
    }: {
      source?: unknown;
      style?: React.ComponentProps<typeof View>['style'];
      tintColor?: string;
      contentFit?: string;
      testID?: string;
    }) => {
      if (testID !== undefined && contentFit !== undefined) {
        contentFits.set(testID, contentFit);
      }
      return (
        // The tint is painted as a BACKGROUND, the way `sign-in.test.tsx`'s stub
        // does it: that is the only channel through which the colour the real
        // (native) Image would have tinted an echo with becomes visible to a test.
        <View
          testID={testID}
          style={[
            style,
            tintColor === undefined ? null : { backgroundColor: tintColor },
          ]}
          accessibilityLabel={typeof source === 'string' ? source : ''}
        />
      );
    },
  };
});

/**
 * The blink clock is stubbed so the chain can be COUNTED rather than timed.
 *
 * `vi.getTimerCount()` cannot answer "is a blink armed?" here: react-native-web
 * schedules timers of its own during a render, so the number is neither 1 nor stable.
 * Counting `next()` calls asks the question directly — one per armed blink, and none
 * at all once the component is gone.
 */
const blinkClock = vi.hoisted(() => ({
  created: vi.fn(),
  next: vi.fn(() => ({ delayMs: 2000, double: false })),
}));

vi.mock('./blink-clock', () => ({
  createBlinkClock: (): { next: () => { delayMs: number; double: boolean } } => {
    blinkClock.created();
    return { next: blinkClock.next };
  },
}));

/** See `light-sweep.test.tsx`: the store caches for the life of the module by design. */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

/**
 * jsdom has no layout engine and no `ResizeObserver`, so react-native-web's `onLayout`
 * never fires on its own and `Scanlines` would sit forever at its unmeasured state —
 * drawing nothing, and passing. Same stub as `light-sweep.test.tsx`.
 */
const box = { width: 250, height: 250 };

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

/**
 * THE PLACEMENT CONTRACT, restated from `scripts/make_blink_patch.sh` and Task 8's
 * report. These are the numbers the script prints on every run; if the crop is ever
 * re-pinned, both places change together or this test fails — which is the point.
 */
const CONTRACT = { left: 33.493, top: 38.756, width: 31.26, height: 15.789 };

const INK = cobaltPalette.ink;

beforeAll(() => {
  // react-native-web caches ONE observer the first time a view asks for it, so this
  // has to be in place before the first render in the file.
  globalThis.ResizeObserver = StubResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => box.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => box.height,
  });
});

beforeEach(() => {
  reduced.value = false;
  reanimatedSpies.withRepeat.mockClear();
  blinkClock.created.mockClear();
  blinkClock.next.mockClear();
});

/** A percentage style value, as a number. */
function percent(element: Element, property: 'left' | 'top' | 'width' | 'height'): number {
  return parseFloat(getComputedStyle(element).getPropertyValue(property));
}

describe('MascotStage — the figure', () => {
  it('draws the open-eyes frame as the base, always', () => {
    render(<MascotStage color={INK} />);

    expect(screen.getByTestId('mascot-base')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('eyes-open.png') as unknown as string,
    );
  });

  it('blinks with the eye PATCH, never the whole closed frame', () => {
    // The full-frame swap is what Task 8 exists to prevent: the two generations are
    // not pixel-identical, so cross-fading them shifts her whole face.
    const { container } = render(<MascotStage color={INK} />);

    expect(screen.getByTestId('mascot-patch-art')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('eye-patch.png') as unknown as string,
    );
    expect(container.innerHTML).not.toContain('eyes-closed');
  });

  it('places the patch exactly where the crop was taken from', () => {
    render(<MascotStage color={INK} />);
    const patch = screen.getByTestId('mascot-patch');

    expect(percent(patch, 'left')).toBeCloseTo(CONTRACT.left, 3);
    expect(percent(patch, 'top')).toBeCloseTo(CONTRACT.top, 3);
    expect(percent(patch, 'width')).toBeCloseTo(CONTRACT.width, 3);
    expect(percent(patch, 'height')).toBeCloseTo(CONTRACT.height, 3);
    // And STRETCHED back into that box, not fitted inside it: `contain` would
    // letterbox the crop and hang a misregistered rectangle over her eyes.
    expect(contentFits.get('mascot-patch-art')).toBe('fill');
    // The full frame is the opposite case, and the pair is what makes the line
    // above an assertion about the PATCH rather than about expo-image's default.
    expect(contentFits.get('mascot-base')).toBe('contain');
  });

  it('keeps the patch invisible between blinks', () => {
    // At rest the patch is fully transparent, so her open eyes are the ONLY thing
    // drawn there. A patch resting at any opacity above zero is a permanent squint.
    render(<MascotStage color={INK} />);

    expect(getComputedStyle(screen.getByTestId('mascot-patch')).opacity).toBe('0');
  });

  it('rides scanlines over her at the spec strength', async () => {
    render(<MascotStage color={INK} />);
    const scanlines = screen.getByTestId('mascot-scanlines');

    // Spec §7: ~5% at rest. The glitch doubles it; that lives in the timeline, which
    // is why the strength is driven from here rather than left to `Scanlines`.
    expect(parseFloat(getComputedStyle(scanlines).opacity)).toBeCloseTo(0.05, 3);
    // The lines themselves arrive a frame later — `Scanlines` rules to its MEASURED
    // height, and the measurement is asynchronous.
    await waitFor(() => {
      expect(scanlines.querySelectorAll('rect').length).toBeGreaterThan(1);
    });
  });

  it('takes its box from `size`', () => {
    render(<MascotStage color={INK} size={120} />);

    const stage = getComputedStyle(screen.getByTestId('mascot-stage'));
    expect(stage.width).toBe('120px');
    expect(stage.height).toBe('120px');
  });
});

describe('MascotStage — the tear', () => {
  it('carries every glitch layer the spec names', () => {
    render(<MascotStage color={INK} />);

    for (const id of ['mascot-ghost-a', 'mascot-ghost-b', 'mascot-slice', 'mascot-track']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('keeps the two echoes duotone — same art, no new colour', () => {
    // Spec §11: a third colour is a violation. The echoes are the SAME image lifted
    // and darkened, which is why they may not carry a source of their own.
    render(<MascotStage color={INK} />);

    for (const id of ['mascot-ghost-a', 'mascot-ghost-b']) {
      for (const layer of screen.getByTestId(id).querySelectorAll('[aria-label]')) {
        expect(layer.getAttribute('aria-label')).toContain('eyes-open.png');
      }
    }

    // The hot echo carries a TINT, and that tint is the ink it was handed — the one
    // place in her tree where a colour is applied rather than drawn, and the one the
    // first-image-only check above used to walk straight past.
    const tinted = [
      ...screen.getByTestId('mascot-ghost-a').querySelectorAll('[aria-label]'),
    ].filter(
      (layer) =>
        normaliseColor(getComputedStyle(layer).backgroundColor) ===
        normaliseColor(INK),
    );
    expect(tinted).toHaveLength(1);
  });

  it('breathes on a loop', () => {
    render(<MascotStage color={INK} />);

    expect(reanimatedSpies.withRepeat).toHaveBeenCalled();
  });
});

describe('MascotStage — sparkles', () => {
  it('twinkles by default', () => {
    render(<MascotStage color={INK} />);

    expect(screen.getAllByText('✦').length).toBeGreaterThan(1);
  });

  it('goes without them when asked', () => {
    render(<MascotStage color={INK} sparkles={false} />);

    expect(screen.queryByText('✦')).toBeNull();
  });

  it('never lets one of them become a screen-reader stop', () => {
    // THE DECORATIVE RULING (`design/decorative.ts`). `pointerEvents: 'none'` on the
    // stage stops a tap and does nothing at all for assistive tech, so five bare `✦`
    // glyphs were five stops on the way into the screen. The whole stage is hidden,
    // which is why the assertion is that each sparkle sits INSIDE the hidden node
    // rather than that each carries the attribute itself.
    render(<MascotStage color={INK} />);

    const stage = screen.getByTestId('mascot-stage');
    expect(stage).toHaveAttribute('aria-hidden', 'true');
    for (const sparkle of screen.getAllByText('✦')) {
      expect(stage).toContainElement(sparkle);
    }
  });
});

describe('MascotStage — reduced motion', () => {
  it('leaves her still rather than stopped', () => {
    reduced.value = true;
    render(<MascotStage color={INK} />);

    // What remains is a drawing someone would have made on purpose: her open eyes,
    // the projection texture, and nothing in motion.
    expect(screen.getByTestId('mascot-base')).toBeInTheDocument();
    expect(screen.getByTestId('mascot-scanlines')).toBeInTheDocument();

    for (const id of ['mascot-ghost-a', 'mascot-ghost-b', 'mascot-slice', 'mascot-track']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('starts no animation and never even builds a blink clock', () => {
    reduced.value = true;
    render(<MascotStage color={INK} />);

    expect(reanimatedSpies.withRepeat).not.toHaveBeenCalled();
    expect(blinkClock.created).not.toHaveBeenCalled();
  });
});

describe('MascotStage — the blink chain', () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('arms the next blink from inside the one that just fired', () => {
    render(<MascotStage color={INK} />);
    expect(blinkClock.next).toHaveBeenCalledTimes(1);

    // A chain, not a single shot: each event has to schedule its successor, or she
    // blinks once on mount and is a still image for the rest of the session.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(blinkClock.next).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(blinkClock.next).toHaveBeenCalledTimes(3);
  });

  it('stops the chain dead when it unmounts', () => {
    // The pending timer is the one that re-arms, so a chain that survives unmount
    // never stops — it fires into a tree that is gone, forever.
    const { unmount } = render(<MascotStage color={INK} />);
    expect(blinkClock.next).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(blinkClock.next).toHaveBeenCalledTimes(1);
  });
});
