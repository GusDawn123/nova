import type { ViewProps } from 'react-native';

/**
 * THE DECORATIVE RULING — one answer for the whole design layer.
 *
 * Nova's surfaces are drawn out of layers that carry no information: the chamfer
 * outline behind a button, the scanlines over the mascot, the sparkles around her,
 * the orbiting ring beside the words that say what is being waited on, the light
 * travelling along a rail, the block caret on the write-head. A sighted reader takes
 * all of it as atmosphere. A screen reader, given nothing, does not — it walks into
 * five `✦` glyphs before it reaches `NOVA` on the front door of the app.
 *
 * `pointerEvents: 'none'` — which most of these layers already carry — stops a TAP
 * and does nothing whatsoever for assistive tech. This is the other half of that
 * sentence, and it is spread onto the HIGHEST container that is wholly decorative,
 * never onto a wrapper that also holds content.
 *
 * ---------------------------------------------------------------------------
 * Why three props and not one
 * ---------------------------------------------------------------------------
 * The same split `app-tabs.tsx` documents for `accessibilityState` / `aria-selected`,
 * in the other direction. `accessibilityElementsHidden` (iOS) and
 * `importantForAccessibility: 'no-hide-descendants'` (Android) are the native pair;
 * react-native-web 0.21 forwards NEITHER — verified, not assumed — and emits
 * `aria-hidden` only when the aria prop is passed explicitly. React Native's own View
 * does translate `aria-hidden` to the native pair, so the aria prop alone would work
 * on device; the pair is kept because it is what every RN reader looks for first, and
 * because it is what fails loudly if a future renderer drops the aria alias.
 *
 * Web is not a side target here: it is where the whole suite runs, so `aria-hidden`
 * on the DOM node is the only form of this ruling a test can actually see.
 */
export const decorative: Required<
  Pick<
    ViewProps,
    'accessibilityElementsHidden' | 'importantForAccessibility' | 'aria-hidden'
  >
> = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
  'aria-hidden': true,
};
