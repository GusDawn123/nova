/**
 * A layout engine, for tests that need one.
 *
 * jsdom measures nothing: it has no `ResizeObserver` and every box is 0x0. Any
 * surface that draws itself from its measured size — `ChamferSurface`, `Scanlines`,
 * `LightSweep` — therefore sits forever at its unmeasured state, drawing nothing and
 * passing every assertion by rendering an empty tree.
 *
 * These two stubs supply exactly what a browser supplies: an observer that reports
 * the node it was handed, and a box for react-native-web's `UIManager.measure` to
 * read off `offsetWidth`/`offsetHeight`.
 *
 * Call it from `beforeAll` — react-native-web caches ONE observer the first time a
 * view asks for it, so it has to be installed before the first render in the file.
 * The returned box is live: assign to it (in `beforeEach`, or mid-test before a
 * re-render) to change what every subsequent measurement reports.
 */

export interface LayoutBox {
  width: number;
  height: number;
}

/**
 * A whole entry, not a `{ target }` shim: a consumer that reads `contentRect.width`
 * off it should get the same number `offsetWidth` reports rather than a crash.
 */
function entryFor(target: Element): ResizeObserverEntry {
  const element = target as HTMLElement;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
  };
  const size: ResizeObserverSize = { inlineSize: width, blockSize: height };

  return {
    target,
    contentRect: { ...rect, toJSON: () => rect } as DOMRectReadOnly,
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
  };
}

class StubResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    // The NEW target only, which is what a real observer reports on `observe` —
    // re-reporting every node seen so far makes each additional surface in a screen
    // cost a pass over all the others, and hands consumers entries for nodes that
    // did not resize.
    if (this.targets.has(target)) return;
    this.targets.add(target);
    this.callback([entryFor(target)], this);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }
}

export function installLayoutStub(width = 200, height = 44): LayoutBox {
  const box: LayoutBox = { width, height };

  globalThis.ResizeObserver = StubResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => box.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => box.height,
  });

  return box;
}
