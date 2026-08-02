import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { reanimatedSpies } from '@/testing/reanimated-stub';

import { LightSweep } from './light-sweep';
import { RingOrbit } from './ring-orbit';
import { Scanlines } from './scanlines';
import { cobaltPalette } from './tokens';

/**
 * The three motion instruments
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6).
 *
 * Two things are worth proving here and nothing else is: that each instrument draws
 * the shape the spec describes at the size it was measured at, and that reduced
 * motion removes the MOVING part rather than freezing it. The second is checked from
 * both sides — the moving node is absent from the tree, AND no repeating animation
 * was ever started.
 *
 * Reanimated cannot render under vitest at all; the shared stub in
 * `testing/reanimated-stub.ts` says why, and carries the `withRepeat` spy the
 * reduced-motion assertions below read.
 */
vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * `useReducedMotion` is mocked rather than driven through `AccessibilityInfo`: the
 * real store caches its value for the life of the module by design (see
 * `motion.ts`), so a test that flipped the OS setting would leak into every test
 * after it.
 */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('./motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./motion')>()),
  useReducedMotion: () => reduced.value,
}));

/**
 * jsdom has no layout engine and no `ResizeObserver`, so react-native-web's
 * `onLayout` never fires on its own and every measured component would sit forever
 * at its unmeasured state — drawing nothing, and passing. Same stubs as
 * `chamfer.test.tsx`: an observer that reports the node it was handed, and a box for
 * `UIManager.measure` to read off `offsetWidth`/`offsetHeight`.
 */
const box = { width: 100, height: 100 };

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
    get: () => box.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => box.height,
  });
});

beforeEach(() => {
  box.width = 100;
  box.height = 100;
  reduced.value = false;
  reanimatedSpies.withRepeat.mockClear();
});

describe('LightSweep', () => {
  it('travels a gradient band along its track', async () => {
    const { container } = render(<LightSweep color={cobaltPalette.ink} />);

    expect(await screen.findByTestId('light-sweep-band')).toBeInTheDocument();
    // A gradient, not a block of colour: a hard-edged box sliding past reads as an
    // object moving, where the effect wanted is light passing over.
    await waitFor(() => {
      expect(container.querySelector('linearGradient')).toBeTruthy();
    });
    expect(reanimatedSpies.withRepeat).toHaveBeenCalled();
  });

  it('paints the light in the colour it was handed', async () => {
    const { container } = render(<LightSweep color={cobaltPalette.ink} />);

    await waitFor(() => {
      expect(container.querySelector('stop')).toBeTruthy();
    });
    const stops = [...container.querySelectorAll('stop')];
    expect(stops).toHaveLength(3);
    for (const stop of stops) {
      expect(stop.getAttribute('stop-color')).toBe(cobaltPalette.ink);
    }
  });

  it('is a hairline by default, and exactly as tall as asked', () => {
    const thin = render(<LightSweep color={cobaltPalette.ink} />);
    const thick = render(<LightSweep color={cobaltPalette.ink} height={6} />);

    const [thinTrack, thickTrack] = [
      thin.container.firstElementChild,
      thick.container.firstElementChild,
    ];
    if (thinTrack === null || thickTrack === null) {
      throw new Error('expected both tracks');
    }
    expect(getComputedStyle(thinTrack).height).toBe('2px');
    expect(getComputedStyle(thickTrack).height).toBe('6px');
  });

  it('says nothing to a screen reader', () => {
    // THE DECORATIVE RULING (`design/decorative.ts`). The rail is the wordless half
    // of a message — "WRITING NOTES" is always beside it — and it reports no progress
    // a reader could announce, so the whole track is out of the tree.
    const { container } = render(<LightSweep color={cobaltPalette.ink} />);

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('stills to a faint line under reduced motion', async () => {
    reduced.value = true;

    const { container } = render(<LightSweep color={cobaltPalette.ink} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The rail survives — it is the "something is happening here" mark. The band,
    // the gradient, and the loop driving them do not.
    expect(container.firstElementChild).toBeTruthy();
    expect(screen.queryByTestId('light-sweep-band')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    expect(reanimatedSpies.withRepeat).not.toHaveBeenCalled();
  });
});

/** The steady ring is drawn first; the inner one rides the rotor over it. */
function innerCircle(container: HTMLElement): SVGCircleElement {
  const circles = [...container.querySelectorAll('circle')];
  expect(circles).toHaveLength(2);
  const inner = circles[1];
  if (inner === undefined) throw new Error('expected an inner ring');
  return inner;
}

describe('RingOrbit', () => {
  it('draws the double ring and turns the inner arc', () => {
    const { container } = render(<RingOrbit color={cobaltPalette.ink} />);

    // The dash pattern IS the arc: one dash, then a gap the length of the circle.
    expect(innerCircle(container).getAttribute('stroke-dasharray')).toBeTruthy();
    expect(screen.getByTestId('ring-orbit-rotor')).toBeInTheDocument();
    expect(reanimatedSpies.withRepeat).toHaveBeenCalled();
  });

  it('takes the size it is given', () => {
    const { container } = render(
      <RingOrbit color={cobaltPalette.ink} size={40} />,
    );

    const root = container.firstElementChild;
    if (root === null) throw new Error('expected a ring');
    expect(getComputedStyle(root).width).toBe('40px');
    expect(getComputedStyle(root).height).toBe('40px');
  });

  it('closes the arc into a full second ring under reduced motion', () => {
    reduced.value = true;

    const { container } = render(<RingOrbit color={cobaltPalette.ink} />);

    // A parked 28% arc is a stalled spinner, not a resting mark. The dash pattern
    // has to GO, not just stop moving — two whole rings is the resting form.
    expect(innerCircle(container).hasAttribute('stroke-dasharray')).toBe(false);
    expect(screen.queryByTestId('ring-orbit-rotor')).toBeNull();
    expect(reanimatedSpies.withRepeat).not.toHaveBeenCalled();
  });
});

describe('Scanlines', () => {
  it('rules one line every four points of its measured height', async () => {
    const { container } = render(<Scanlines color={cobaltPalette.ink} />);

    await waitFor(() => {
      expect(container.querySelectorAll('rect').length).toBeGreaterThan(10);
    });
    // 100pt tall, one line per 4pt.
    expect(container.querySelectorAll('rect')).toHaveLength(25);
  });

  it('draws nothing until it has a box to rule', async () => {
    box.width = 0;
    box.height = 0;

    const { container } = render(<Scanlines color={cobaltPalette.ink} />);

    // Wait the measurement round-trip out rather than asserting on the first frame,
    // where nothing is drawn yet for an entirely different reason.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('rect')).toBeNull();
  });

  it('never intercepts a tap', async () => {
    const { container } = render(<Scanlines color={cobaltPalette.ink} />);

    const overlay = container.firstElementChild;
    if (overlay === null) throw new Error('expected an overlay');
    await waitFor(() => {
      expect(container.querySelector('rect')).toBeTruthy();
    });
    expect(getComputedStyle(overlay).pointerEvents).toBe('none');
  });

  it('is static by design — reduced motion changes nothing', async () => {
    reduced.value = true;

    const { container } = render(<Scanlines color={cobaltPalette.ink} />);

    await waitFor(() => {
      expect(container.querySelectorAll('rect')).toHaveLength(25);
    });
    expect(reanimatedSpies.withRepeat).not.toHaveBeenCalled();
  });
});
