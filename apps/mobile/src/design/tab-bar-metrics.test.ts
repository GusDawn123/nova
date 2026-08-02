import { describe, expect, it } from 'vitest';

import {
  TAB_BAR_HEIGHT,
  recordDotColor,
  tabBarClearance,
} from './tab-bar-metrics';
import { cobaltPalette, paperPalette, type Palette } from './tokens';

/**
 * The floating tab bar is `position: absolute`, so it reserves NO layout space.
 * Every screen therefore has to leave room for it by hand — and the Live screen
 * did not, which put its "Start session" button underneath the bar where it could
 * not be tapped.
 *
 * The number lived nowhere, so each screen guessed. These tests pin it.
 */

describe('tabBarClearance', () => {
  it('always clears the bar itself', () => {
    expect(tabBarClearance(0)).toBeGreaterThan(TAB_BAR_HEIGHT);
  });

  it('grows with the home-indicator inset', () => {
    // The bar floats above the inset, so a taller inset pushes it further up and
    // the content must retreat by the same amount.
    expect(tabBarClearance(34)).toBeGreaterThan(tabBarClearance(0));
  });

  it('does not shrink below the mock spacing on a device with no inset', () => {
    // The design floats the bar 26px off the bottom even where there is no home
    // indicator, so clearance can never collapse to just the bar height.
    expect(tabBarClearance(0)).toBeGreaterThanOrEqual(TAB_BAR_HEIGHT + 26);
  });

  it('leaves the bar a visible gap rather than butting content against it', () => {
    const inset = 34;
    const barTopFromBottom = Math.max(26, inset + 10) + TAB_BAR_HEIGHT;

    expect(tabBarClearance(inset)).toBeGreaterThan(barTopFromBottom);
  });
});

/**
 * In a duotone, "is the record dot visible" is not a matter of taste — it is an
 * equality check against the surface under it. That surface changes with focus (the
 * focused tab is filled with `ink`, the unfocused one shows the bar's raised fill),
 * so no single token satisfies both, which is exactly the regression this guards.
 */
const THEMES: { name: string; palette: Palette }[] = [
  { name: 'cobalt', palette: cobaltPalette },
  { name: 'paper', palette: paperPalette },
];

/**
 * What the dot is drawn on: the selected tab's full-ink fill when focused, and the
 * bar's own opaque canvas slab when not (`app-tabs.tsx` — keep the two in step).
 */
function surfaceUnderDot(palette: Palette, isFocused: boolean): string {
  return isFocused ? palette.ink : palette.canvas;
}

describe('recordDotColor', () => {
  it.each(THEMES)(
    'never matches the surface under it, focused or not ($name)',
    ({ palette }) => {
      for (const isFocused of [true, false]) {
        expect(recordDotColor(palette, isFocused)).not.toBe(
          surfaceUnderDot(palette, isFocused),
        );
      }
    },
  );

  it.each(THEMES)(
    'takes the canvas colour on the focused tab, whose fill is full ink ($name)',
    ({ palette }) => {
      // During a live call the user is normally ON this tab, so this is the case
      // that must not regress.
      expect(recordDotColor(palette, true)).toBe(palette.onInk);
      expect(recordDotColor(palette, true)).toBe(palette.canvas);
    },
  );

  it.each(THEMES)(
    'takes full ink on an unfocused tab, where the canvas colour would vanish ($name)',
    ({ palette }) => {
      expect(recordDotColor(palette, false)).toBe(palette.ink);
      expect(recordDotColor(palette, false)).not.toBe(palette.canvas);
    },
  );
});
