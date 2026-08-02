import { describe, expect, it } from 'vitest';

import { TAB_BAR_HEIGHT, tabBarClearance } from './tab-bar-metrics';

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
