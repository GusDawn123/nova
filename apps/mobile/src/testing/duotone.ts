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
 * from the palette. EVERY surface a colour can enter through is read, because a
 * guard that covers four of them is a guard that will be trusted about the fifth:
 *
 *   - text colour, and the background behind it;
 *   - all FOUR border sides (a left-only accent stripe is a classic third colour);
 *   - `background-image` — spec §2 permits gradients only as light sweeps, and a
 *     sweep's COLOUR STOPS are still palette members;
 *   - `box-shadow` / `text-shadow`, which is where a stray black creeps in;
 *   - the SVG that the chamfer, the scanlines and the mascot's glow draw into:
 *     `fill`, `stroke`, and `stop-color` on every gradient stop;
 *   - and, belt and braces, any colour written into an inline `style` attribute,
 *     since jsdom's computed view silently drops values it cannot parse.
 *
 * Deliberately NOT a grep for `red`: the failure this catches is any colour off the
 * palette, whatever it happens to be called. Named colours, `#abc`, `#aabbcc`,
 * `rgb()`, `rgba()` and `hsl()` are all canonicalised before comparison.
 *
 * Proven non-vacuous by `duotone.test.tsx`, which breaches one surface per test.
 */

/** `rgb(0, 2, 218)` / `rgba(0,2,218,0.35)` / `#0002DA` / `#02d` all compare equal. */
export function normaliseColor(value: string): string {
  const trimmed = expandShortHex(value.trim().toLowerCase());

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

/** `#02d` → `#0022dd`. */
function expandShortHex(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  return short === null ? value : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
}

/**
 * The CSS colour keywords, as NAMES rather than values.
 *
 * They are here because the alternative does not work: jsdom's CSS parser accepts
 * any bare identifier as a colour (`style.color = 'background'` round-trips), so
 * asking the parser "is this a colour?" says yes to every word in a compound value.
 * A name only has to be RECOGNISED here — none of them can be a palette member, and
 * the duotone is written in hex and rgba, so a named colour on screen is a breach by
 * construction. `white`/`black` are canonicalised anyway, since those two could be
 * an honest spelling of a brand colour rather than a third one.
 */
const NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
   blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue
   cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
   darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
   darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
   deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
   fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
   hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
   lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey
   lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey
   lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
   mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
   mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose
   moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
   palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink
   plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon
   sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey
   snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
   whitesmoke yellow yellowgreen`
    .split(/\s+/)
    .filter((name) => name !== ''),
);

const NAMED_CANONICAL: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
};

/**
 * Canonicalise a value IF it is a colour, and return `null` if it is not — which is
 * how the compound-value scanner below tells colours (`#fff`, `crimson`) from
 * everything else in a gradient or shadow (`45deg`, `linear-gradient`, `2px`).
 *
 * `url(#glow)` is a paint REFERENCE, not a colour: the colour it resolves to lives
 * on the gradient's stops, and those are read directly.
 */
function asColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();

  if (trimmed.startsWith('url(')) return null;
  if (NAMED_COLORS.has(trimmed)) {
    // Through `normaliseColor`, not returned raw: the palette's own white arrives as
    // a hex and is canonicalised to `rgb(…)`, so a raw `#ffffff` here would fail to
    // match the very value it is a spelling of.
    const canonical = NAMED_CANONICAL[trimmed];
    return canonical === undefined ? trimmed : normaliseColor(canonical);
  }
  if (INVISIBLE.has(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3,8}$/.test(trimmed) || /^(?:rgba?|hsla?)\(/.test(trimmed)) {
    return normaliseColor(trimmed);
  }

  return null;
}

/** Hex and functional notations, pulled out of a compound value before tokenising. */
const COLOR_NOTATION = /#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([^)]*\)/gi;

/**
 * Every colour inside a compound value — `linear-gradient(180deg, #fff 0%, red)`,
 * `0 2px 8px rgba(0,0,0,0.4)`, or a whole inline `style` attribute.
 */
function extractColors(value: string): string[] {
  const found = [...(value.match(COLOR_NOTATION) ?? [])];

  // What is left is words: a few of them are named colours, most are keywords,
  // property names and units. The keyword table above decides which is which.
  for (const word of value.replace(COLOR_NOTATION, ' ').split(/[^a-z]+/i)) {
    if (word !== '' && asColor(word) !== null) found.push(word);
  }

  return found;
}

function allowedValues(palette: Palette): Set<string> {
  return new Set(
    Object.values(palette)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => asColor(value) ?? normaliseColor(value)),
  );
}

/** Does this element carry its own text, rather than only wrapping children? */
function hasOwnText(element: Element): boolean {
  return [...element.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  );
}

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;

export function expectDuotoneOnly(container: HTMLElement, palette: Palette): void {
  const allowed = allowedValues(palette);
  const offenders: string[] = [];

  /** A property whose whole value is one colour — or is not a colour at all. */
  const check = (where: string, value: string | null | undefined): void => {
    if (value === null || value === undefined) return;
    const color = asColor(value);
    if (color === null || INVISIBLE.has(color) || allowed.has(color)) return;
    offenders.push(`${where}: ${value}`);
  };

  /** A property that can carry several colours among other tokens. */
  const checkCompound = (where: string, value: string | null | undefined): void => {
    if (value === null || value === undefined || value === '') return;
    for (const color of extractColors(value)) check(where, color);
  };

  for (const element of container.querySelectorAll('*')) {
    const tag = element.tagName;
    const style = getComputedStyle(element);

    // Anything written inline, whatever the property — jsdom drops values from the
    // computed view that it cannot parse, and this is the copy it cannot drop.
    checkCompound(`${tag} style`, element.getAttribute('style'));

    if (element instanceof SVGElement) {
      check(`${tag} fill`, element.getAttribute('fill'));
      check(`${tag} stroke`, element.getAttribute('stroke'));
      // The mascot's glow and the tear track are gradients: their stops are where
      // their colour actually lives.
      check(`${tag} stop-color`, element.getAttribute('stop-color'));
      check(`${tag} stop-color`, style.getPropertyValue('stop-color'));
      // No computed-style pass for an SVG node: react-native-svg emits `fill` and
      // `stroke` as ATTRIBUTES, which the three reads above already cover, and
      // jsdom's computed view reports the CSS initial values for them on every SVG
      // element — a black that nothing painted, and a false offender on every icon.
      continue;
    }

    if (hasOwnText(element)) check(`text "${element.textContent ?? ''}"`, style.color);
    check(`${tag} background`, style.backgroundColor);
    checkCompound(`${tag} background-image`, style.backgroundImage);
    checkCompound(`${tag} box-shadow`, style.boxShadow);
    checkCompound(`${tag} text-shadow`, style.textShadow);

    for (const side of BORDER_SIDES) {
      // A colour on a side with no width paints nothing — and react-native-web
      // leaves `border-*-color` at its initial black on every view it renders.
      const width = style.getPropertyValue(`border-${side}-width`);
      if (width === '' || width === '0px') continue;
      check(`${tag} border-${side}`, style.getPropertyValue(`border-${side}-color`));
    }
  }

  expect(offenders, `colour off the duotone palette:\n${offenders.join('\n')}`).toEqual(
    [],
  );
}
