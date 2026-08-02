import { render, screen } from '@testing-library/react';
import { Text, View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { decorative } from './decorative';

/**
 * The decorative ruling, pinned where it is declared.
 *
 * Its consumers each assert their own layer — the mascot stage, the chamfer layer,
 * the sweep track, the caret. What only this file can hold is WHY the constant has
 * three keys rather than one, which is a fact about the renderer and not about any
 * of them: react-native-web 0.21 forwards neither of the native props, so the aria
 * prop is the only one of the three a browser — or this whole test suite — can see.
 *
 * The second test is deliberately an assertion about a dependency. If a later
 * react-native-web starts forwarding the native pair it FAILS, which is the correct
 * outcome: that is the day the aria prop stops being load-bearing and the comment in
 * `decorative.ts` stops being true.
 */
describe('the decorative ruling', () => {
  it('carries both native props and the aria one', () => {
    // iOS reads `accessibilityElementsHidden`, Android reads
    // `importantForAccessibility`, the web reads `aria-hidden`. Nothing here is
    // redundant on the platform it is for.
    expect(decorative).toEqual({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
      'aria-hidden': true,
    });
  });

  it('reaches the DOM, which the native pair alone does not', () => {
    render(
      <>
        <View testID="ruled" {...decorative}>
          <Text>atmosphere</Text>
        </View>
        <View
          testID="native-only"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text>also atmosphere</Text>
        </View>
      </>,
    );

    expect(screen.getByTestId('ruled')).toHaveAttribute('aria-hidden', 'true');
    // The non-vacuity half: without the aria prop the layer is still announced, so a
    // suite that only asserted the native pair would pass while VoiceOver read every
    // sparkle in the app.
    expect(screen.getByTestId('native-only')).not.toHaveAttribute('aria-hidden');
  });
});
