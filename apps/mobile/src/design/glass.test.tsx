import { render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { GlassPill, GlassSurface } from './glass';
import { cobaltPalette, paperPalette, Radius } from './tokens';

/**
 * Glass surface behaviour (Phase 8.5, §7.1).
 *
 * `expo-glass-effect` is a native module with no web implementation, so it is mocked
 * here — `vi.mock` hoists, which is why this lives in the test file rather than the
 * shared setup. The mock reports glass as UNAVAILABLE, which makes these tests cover
 * the case that actually matters: the fallback path taken on older iOS, Android and
 * web, where the surface must still carry its own fill, border and radius rather
 * than degrading to an invisible `View`.
 *
 * What real liquid glass looks like on iOS 26 is verified on the simulator by eye.
 */
vi.mock('expo-glass-effect', () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => false,
}));

describe('GlassSurface', () => {
  it('renders its children', () => {
    render(
      <GlassSurface palette={cobaltPalette}>
        <Text>notes go here</Text>
      </GlassSurface>,
    );

    expect(screen.getByText('notes go here')).toBeInTheDocument();
  });

  it('paints its own fill and border when liquid glass is unavailable', () => {
    // The whole point of the fallback: without this the card is an invisible View
    // on every platform below iOS 26.
    render(<GlassSurface palette={cobaltPalette} testID="surface" />);

    const style = getComputedStyle(screen.getByTestId('surface'));
    expect(style.backgroundColor).not.toBe('');
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
  });

  it('uses the raised fill for tone="raised"', () => {
    render(
      <>
        <GlassSurface palette={cobaltPalette} testID="regular" />
        <GlassSurface palette={cobaltPalette} tone="raised" testID="raised" />
      </>,
    );

    const regular = getComputedStyle(screen.getByTestId('regular'));
    const raised = getComputedStyle(screen.getByTestId('raised'));
    expect(raised.backgroundColor).not.toBe(regular.backgroundColor);
  });

  it('applies the requested radius, and the card radius by default', () => {
    render(
      <>
        <GlassSurface palette={cobaltPalette} testID="default" />
        <GlassSurface palette={cobaltPalette} radius={8} testID="custom" />
      </>,
    );

    expect(getComputedStyle(screen.getByTestId('default')).borderTopLeftRadius).toBe(
      `${String(Radius.card)}px`,
    );
    expect(getComputedStyle(screen.getByTestId('custom')).borderTopLeftRadius).toBe(
      '8px',
    );
  });

  it('casts its shadow from OUTSIDE the node that clips', () => {
    // iOS clips the shadow of any view that also sets `overflow: hidden`, so a
    // surface doing both on one node loses its shadow there while Android's
    // `elevation` — drawn by the platform, not the layer — keeps showing. Split or
    // it regresses on exactly one platform, silently.
    render(<GlassSurface palette={cobaltPalette} elevated testID="elevated" />);

    const clipped = screen.getByTestId('elevated');
    const shadowCaster = clipped.parentElement;
    if (shadowCaster === null) throw new Error('expected a wrapping node');

    expect(getComputedStyle(clipped).overflowX).toBe('hidden');
    expect(getComputedStyle(clipped).boxShadow).toBe('');
    expect(getComputedStyle(shadowCaster).boxShadow).not.toBe('');
    expect(getComputedStyle(shadowCaster).overflowX).not.toBe('hidden');
    // The radius has to be on both, or the shadow is cast as a rectangle.
    expect(getComputedStyle(shadowCaster).borderTopLeftRadius).toBe(
      `${String(Radius.card)}px`,
    );
  });

  it('renders differently under the two palettes', () => {
    render(
      <>
        <GlassSurface palette={cobaltPalette} testID="dark" />
        <GlassSurface palette={paperPalette} testID="light" />
      </>,
    );

    expect(getComputedStyle(screen.getByTestId('dark')).backgroundColor).not.toBe(
      getComputedStyle(screen.getByTestId('light')).backgroundColor,
    );
  });
});

describe('GlassPill', () => {
  it('is fully rounded', () => {
    render(<GlassPill palette={cobaltPalette} testID="pill" />);

    const radius = parseFloat(
      getComputedStyle(screen.getByTestId('pill')).borderTopLeftRadius,
    );
    expect(radius).toBeGreaterThanOrEqual(999);
  });
});
