import { expect } from 'vitest';

import type { Palette } from '@/design/tokens';

/**
 * The duotone guard (spec §11 — "no third colour anywhere, including errors").
 *
 * The rule the design lives or dies by is easy to state and easy to break by
 * accident: every colour on screen is the theme's ink or its canvas, at some
 * opacity. An error state is the classic breach — the reflex is to reach for red,
 * and the spec's answer is that errors are said in WORDS and emphasised in INK.
 *
 * So this walks what was actually rendered and asserts every visible colour came
 * from the palette. It reads three places a colour can enter a react-native-web
 * tree: text colour, non-transparent backgrounds, drawn borders, and the `fill` /
 * `stroke` attributes of the SVG the chamfer draws its outline into.
 *
 * Deliberately NOT a grep for `red`: the failure this catches is any colour off the
 * palette, whatever it is called.
 */

/** `rgb(0, 2, 218)` / `rgba(0,2,218,0.35)` / `#0002DA` all compare equal. */
function normalise(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(trimmed);
  if (hex === null) return trimmed.replace(/\s+/g, '');

  const int = parseInt(hex[1], 16);
  return `rgb(${String((int >> 16) & 255)},${String((int >> 8) & 255)},${String(int & 255)})`;
}

/** Values that paint nothing, and so cannot introduce a colour. */
const INVISIBLE = new Set(['', 'none', 'transparent', 'rgba(0,0,0,0)', 'currentcolor']);

function allowedValues(palette: Palette): Set<string> {
  return new Set(
    Object.values(palette)
      .filter((value): value is string => typeof value === 'string')
      .map(normalise),
  );
}

/** Does this element carry its own text, rather than only wrapping children? */
function hasOwnText(element: Element): boolean {
  return [...element.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  );
}

export function expectDuotoneOnly(container: HTMLElement, palette: Palette): void {
  const allowed = allowedValues(palette);
  const offenders: string[] = [];

  const check = (where: string, value: string | null): void => {
    if (value === null) return;
    const normalised = normalise(value);
    if (INVISIBLE.has(normalised) || allowed.has(normalised)) return;
    offenders.push(`${where}: ${value}`);
  };

  for (const element of container.querySelectorAll('*')) {
    if (element instanceof SVGElement) {
      check(`${element.tagName} fill`, element.getAttribute('fill'));
      check(`${element.tagName} stroke`, element.getAttribute('stroke'));
      continue;
    }

    const style = getComputedStyle(element);
    if (hasOwnText(element)) check(`text "${element.textContent ?? ''}"`, style.color);
    check(`${element.tagName} background`, style.backgroundColor);
    if (style.borderTopWidth !== '0px' && style.borderTopWidth !== '') {
      check(`${element.tagName} border`, style.borderTopColor);
    }
  }

  expect(offenders, `colour off the duotone palette:\n${offenders.join('\n')}`).toEqual(
    [],
  );
}
