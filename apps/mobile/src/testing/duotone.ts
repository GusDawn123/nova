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

/**
 * One spelling per colour: `#0002DA`, `rgb(0, 2, 218)` and `rgb(0,2,218)` all come
 * out the same, and so do `rgba(255,255,255,0.10)` and `rgba(255, 255, 255, 0.1)` —
 * the token file writes the first spelling and the browser reports the second.
 */
export function normaliseColor(value: string): string {
  const trimmed = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{6})$/.exec(trimmed);
  if (hex !== null) {
    const int = parseInt(hex[1], 16);
    return `rgb(${[(int >> 16) & 255, (int >> 8) & 255, int & 255].join(',')})`;
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(trimmed);
  if (fn !== null) {
    const parts = fn[1]
      .split(/[,\s/]+/)
      .filter((part) => part !== '')
      .map((part) => String(Number(part)));
    // A fully opaque rgba IS an rgb; comparing them as different strings would fail
    // on nothing but notation.
    const opaque = parts.length === 4 && Number(parts[3]) === 1;
    return parts.length === 4 && !opaque
      ? `rgba(${parts.join(',')})`
      : `rgb(${parts.slice(0, 3).join(',')})`;
  }

  return trimmed.replace(/\s+/g, '');
}

/** Values that paint nothing, and so cannot introduce a colour. */
const INVISIBLE = new Set(['', 'none', 'transparent', 'rgba(0,0,0,0)', 'currentcolor']);

function allowedValues(palette: Palette): Set<string> {
  return new Set(
    Object.values(palette)
      .filter((value): value is string => typeof value === 'string')
      .map(normaliseColor),
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
    const normalised = normaliseColor(value);
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
