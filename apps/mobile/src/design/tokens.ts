/**
 * Design tokens — the duotone spine
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §9).
 *
 * TWO colours exist in this app: brand blue and white. Every other value is one of
 * them at a stated opacity, written out as a literal `rgba()` string per theme
 * rather than computed, so the exact colour a surface paints is greppable here.
 * A third colour — including for errors, risk and success — is a spec violation:
 * words carry meaning, ink carries emphasis (spec §11).
 *
 * The two themes are mirrors, not a light/dark pair of separate designs: cobalt is
 * blue canvas with white ink, paper is white canvas with blue ink, and every
 * derived band sits at the same opacity in both.
 *
 * Through the redesign this file also carried a LEGACY block — the glass-era surface
 * names (`glass`, `stroke`, `ink2`, the shadow quintet, the Spline Sans families, the
 * old type scale) held at duotone VALUES so the not-yet-redrawn screens rendered
 * wrong-but-duotone rather than reintroducing a colour. Every name died with the
 * screen that last used it, and the tab bar took the last of them. What is below is
 * now the whole vocabulary: seven colour tokens, three families, one scale.
 */

/** The two mirror themes. Cobalt is the default; `paper` is the light mirror. */
export type ThemeName = 'cobalt' | 'paper';

/** The one blue. Both themes are built from this and {@link BRAND_WHITE}. */
export const BRAND_BLUE = '#0002DA';
export const BRAND_WHITE = '#FFFFFF';

/** What one theme provides. `canvas` and `ink` are the two poles; the rest derive. */
export interface Palette {
  /** The screen background — the theme's whole field. */
  canvas: string;
  /** Full-strength foreground: primary text, filled controls, rules that matter. */
  ink: string;
  /** ink @ 75% — secondary text. Stays above the ≥65% contrast floor (spec §11). */
  inkSoft: string;
  /** ink @ 45% — placeholders and disabled copy. */
  inkFaint: string;
  /** ink @ 35% — borders, dividers, hairlines. */
  inkHairline: string;
  /** ink @ 10% — card fills, chip fills, the thinking bars. */
  inkFill: string;
  /**
   * Text and glyphs drawn ON an ink-filled control — the selected tab label, the
   * submit key's word. Equals `canvas`, and is a token rather than each surface's
   * own literal so the mirror holds in both themes.
   */
  onInk: string;
}

/** Blue canvas, white ink — the default theme. */
export const cobaltPalette: Palette = {
  canvas: BRAND_BLUE,
  ink: BRAND_WHITE,
  inkSoft: 'rgba(255,255,255,0.75)',
  inkFaint: 'rgba(255,255,255,0.45)',
  inkHairline: 'rgba(255,255,255,0.35)',
  inkFill: 'rgba(255,255,255,0.10)',
  onInk: BRAND_BLUE,
};

/** White canvas, blue ink — the mirror. */
export const paperPalette: Palette = {
  canvas: BRAND_WHITE,
  ink: BRAND_BLUE,
  inkSoft: 'rgba(0,2,218,0.75)',
  inkFaint: 'rgba(0,2,218,0.45)',
  inkHairline: 'rgba(0,2,218,0.35)',
  inkFill: 'rgba(0,2,218,0.10)',
  onInk: BRAND_WHITE,
};

const PALETTES: Record<ThemeName, Palette> = {
  cobalt: cobaltPalette,
  paper: paperPalette,
};

/**
 * The corner cut. Chamfered corners mean actionable; square means static
 * (spec §3), so the cut size is a token rather than a per-surface number.
 */
export const Chamfer = {
  /** Controls: buttons, fields, chips. */
  control: 8,
  /** Large keys — the submit key, the cockpit's one button. */
  key: 10,
} as const;

/**
 * The three voices: Orbitron for display, Inter for body, Space Mono for numerals
 * and machine speech. Loaded by `design/fonts.ts`; an unresolved family falls back
 * to the system face rather than failing.
 */
export const FontFamily = {
  display: 'Orbitron_900Black',
  displayMid: 'Orbitron_700Bold',
  body: 'Inter_400Regular',
  bodySemibold: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
  mono: 'SpaceMono_400Regular',
  monoBold: 'SpaceMono_700Bold',
} as const;

/**
 * The type scale: display 26/21/16/15, body 15/13.5/12.5, mono 11/10/8.5. Half
 * points are deliberate — RN accepts them, and rounding them changes the density
 * the design depends on.
 */
export const FontSize = {
  displayXl: 26,
  displayLg: 21,
  displayMd: 16,
  displaySm: 15,
  body: 15,
  bodySm: 13.5,
  bodyXs: 12.5,
  mono: 11,
  monoSm: 10,
  monoXs: 8.5,
} as const;

/**
 * The uppercase mono eyebrow used for every section label ("tl;dr", "decisions",
 * "grounded in"). One object because it appears a dozen times and drifting letter
 * spacing between them is immediately visible.
 */
export const eyebrowStyle = {
  fontFamily: FontFamily.mono,
  fontSize: FontSize.monoSm,
  letterSpacing: 2,
  textTransform: 'uppercase',
} as const;

/** Corner radii, named for what they wrap rather than by size. */
export const Radius = {
  /** The big content cards (mock 28 / 26 / 24). */
  card: 26,
  /** Secondary cards and list rows (mock 22). */
  cardSmall: 22,
  /** Search bar, inline panels (mock 18). */
  panel: 18,
  /** The quiet Account cards (spec §8) — square enough to read as static. */
  soft: 14,
  /** Buttons (mock 16). */
  button: 16,
  /** Tone segmented control (mock 11-14). */
  segment: 12,
  /** Chips and tags (mock 8). */
  chip: 8,
  /** Checkbox (mock 7). */
  check: 7,
  /** Pills, tab bar, avatars. */
  pill: 999,
} as const;

/**
 * Spacing scale, in the increments the mock actually uses — which is not a clean
 * geometric run, so `xs2` and `sm2` are half-steps sitting between the named sizes
 * rather than rounding the mock's 6 and 8 onto the 4/7/10 rungs. A pixel either way
 * is invisible alone and visible once a card stacks four of them.
 */
export const Space = {
  xs: 4,
  /** Half-step (mock 6): dot→label gutters, chip rows. */
  xs2: 6,
  sm: 7,
  /** Half-step (mock 8): the stack gap inside the condensed in-call cards. */
  sm2: 8,
  md: 10,
  lg: 14,
  xl: 18,
  xxl: 26,
} as const;

/**
 * Fixed sizes the mock declares outright. Separate from {@link Space} because they
 * measure a thing rather than the distance between two things.
 */
export const Size = {
  /** Status and record dots (mock 7). Pair with `Radius.pill` for a circle. */
  dot: 7,
  /** Minimum height of a tappable control — clears the 44pt platform floor. */
  tapTarget: 46,
} as const;

/**
 * What the OS can tell us about its appearance preference.
 *
 * Typed structurally rather than as RN's `ColorSchemeName` to keep this module free
 * of React Native imports — it is pure data, and pure data is testable without a
 * renderer. `'unspecified'` is part of the union because RN's `useColorScheme()` can
 * return it, and every caller passes that value straight in.
 */
export type ColorScheme = 'light' | 'dark' | 'unspecified' | null | undefined;

/**
 * Which theme an OS scheme asks for.
 *
 * Anything that is not explicitly `'light'` resolves to COBALT — which covers `null`
 * (what `useColorScheme` returns before the system value arrives) and `'unspecified'`
 * (what it returns on a platform with no preference). Cobalt is the default theme, so
 * an unresolved scheme must not flash paper.
 */
export function themeForScheme(scheme: ColorScheme): ThemeName {
  return scheme === 'light' ? 'paper' : 'cobalt';
}

/**
 * The palette for a named theme — the seam an explicit user override paints through
 * (`hooks/use-appearance`), where there is a theme but no scheme to read it from.
 */
export function paletteForTheme(theme: ThemeName): Palette {
  return PALETTES[theme];
}

/** Resolve a palette straight from the OS scheme, for callers with no override. */
export function paletteFor(scheme: ColorScheme): Palette {
  return paletteForTheme(themeForScheme(scheme));
}
