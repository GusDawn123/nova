import { act, render, screen, waitFor } from '@testing-library/react';
import { Text } from 'react-native';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { chamferPoints, ChamferSurface } from './chamfer';
import { Chamfer, cobaltPalette } from './tokens';

/**
 * The chamfer primitive (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §3).
 *
 * The geometry is a pure function, so the two assertions that pin the shape need no
 * renderer at all. The component tests exist for the parts a pure function cannot
 * hold: that measurement reaches the polygon, that a zero-size box draws nothing,
 * and that the drawn layer sits behind the children and swallows no taps.
 *
 * jsdom has no layout engine and no `ResizeObserver`, so react-native-web's
 * `onLayout` never fires on its own — every surface here would sit forever at its
 * unmeasured state and the tests would pass by drawing nothing. The two stubs below
 * supply exactly what a browser supplies: an observer that reports the node it was
 * given, and a box for `UIManager.measure` to read off `offsetWidth`/`offsetHeight`.
 */
const box = { width: 100, height: 40 };

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
  box.height = 40;
});

describe('chamferPoints', () => {
  it('cuts exactly the two opposite corners', () => {
    expect(chamferPoints(100, 40, 8)).toBe('8,0 100,0 100,32 92,40 0,40 0,8');
  });

  it('clamps the cut so tiny surfaces stay convex', () => {
    expect(chamferPoints(10, 10, 8)).toBe('5,0 10,0 10,5 5,10 0,10 0,5'); // cut clamped to min(w,h)/2
  });
});

describe('ChamferSurface', () => {
  it('renders children and an svg polygon', async () => {
    const { container } = render(
      <ChamferSurface fill={cobaltPalette.canvas}>
        <Text>press me</Text>
      </ChamferSurface>,
    );

    expect(screen.getByText('press me')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('polygon')).toBeTruthy();
    });
  });

  it('cuts the corners at the measured size, with the control cut by default', async () => {
    const { container } = render(<ChamferSurface stroke={cobaltPalette.ink} />);

    await waitFor(() => {
      expect(container.querySelector('polygon')?.getAttribute('points')).toBe(
        chamferPoints(box.width, box.height, Chamfer.control),
      );
    });
  });

  it('draws nothing until it has a non-zero box', async () => {
    // A zero-size layout would otherwise produce a degenerate polygon — six points
    // all at the origin — which paints a stray dot at the top-left of the screen.
    box.width = 0;
    box.height = 0;

    const { container } = render(
      <ChamferSurface fill={cobaltPalette.inkFill}>
        <Text>still here</Text>
      </ChamferSurface>,
    );

    // Wait the measurement round-trip out rather than asserting on the first frame,
    // where nothing is drawn yet for an entirely different reason.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText('still here')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws the two focus brackets only when asked', async () => {
    const { container } = render(
      <>
        <ChamferSurface stroke={cobaltPalette.inkHairline} testID="resting" />
        <ChamferSurface stroke={cobaltPalette.ink} brackets testID="focused" />
      </>,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('polygon')).toHaveLength(2);
    });
    const [resting, focused] = [
      screen.getByTestId('resting'),
      screen.getByTestId('focused'),
    ];
    expect(resting.querySelectorAll('polyline')).toHaveLength(0);
    expect(focused.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('paints behind its children and swallows no taps', async () => {
    // Both halves matter: an svg layer painted OVER the children hides them, and one
    // that accepts pointer events eats every tap meant for the control it decorates.
    const { container } = render(
      <ChamferSurface fill={cobaltPalette.canvas}>
        <Text>tap target</Text>
      </ChamferSurface>,
    );

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });
    const svg = container.querySelector('svg');
    const label = screen.getByText('tap target');
    if (svg === null) throw new Error('expected the svg layer');
    const layer = svg.parentElement;
    if (layer === null) throw new Error('expected the svg to sit in a layer');

    // Every react-native-web view is `position: relative; z-index: 0`, so document
    // order IS paint order — the same rule as sibling order on native.
    const labelIsAfterSvg =
      svg.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(labelIsAfterSvg).toBeTruthy();
    expect(getComputedStyle(layer).pointerEvents).toBe('none');
  });

  it('hides the drawn layer from assistive tech and nothing else', async () => {
    // THE DECORATIVE RULING (`design/decorative.ts`), on the primitive every button,
    // field, chip and key in the app is built from — so this is the case that would
    // do the most damage if the ruling were applied one level too high. BOTH halves
    // are asserted: the outline is silent, and the label inside it is not, because
    // hiding the surface would take every control's accessible name with it.
    const { container } = render(
      <ChamferSurface fill={cobaltPalette.canvas} testID="surface">
        <Text>tap target</Text>
      </ChamferSurface>,
    );

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });
    const layer = container.querySelector('svg')?.parentElement;
    if (layer == null) throw new Error('expected the svg to sit in a layer');

    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('surface')).not.toHaveAttribute('aria-hidden');
    expect(layer).not.toContainElement(screen.getByText('tap target'));
  });
});
