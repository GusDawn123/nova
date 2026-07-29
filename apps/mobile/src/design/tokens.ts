/**
 * Design tokens for the glass UI (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.1),
 * transcribed from Gustavo's `Nova Mobile glass UI design` mock.
 *
 * The mock is CSS and this is React Native, so two things had to be converted rather
 * than copied:
 *
 *  - **oklch → sRGB hex.** React Native has no `oklch()`. Values were converted with
 *    the Ottosson oklab transform rather than eyeballed; the source oklch is kept in
 *    a comment beside each so the mock stays the source of truth. One value (the
 *    light `accent2`) is outside the sRGB gamut and is the clipped result — noted
 *    where it appears.
 *  - **`color-mix(in oklab, …)` → literal rgba.** `accentSoft` is the accent at 60%
 *    and `accentGlow` at 30%, pre-resolved per theme.
 *
 * The mock's gradients (`--stage`, `--screen`) are not tokens here: RN needs
 * `expo-linear-gradient` for those, and the screens that use them declare their own
 * stops. The flat `screenBase` below is the colour to paint under a gradient (and the
 * whole background where a gradient would be gratuitous).
 */

/** The palette one theme provides. Keys mirror the mock's CSS custom properties. */
export interface Palette {
  /** oklch(0.72 0.13 268) dark · oklch(0.56 0.15 268) light */
  accent: string;
  /** oklch(0.74 0.12 205) dark · oklch(0.58 0.13 205) light */
  accent2: string;
  /** accent @ 60% — hairlines and quote rules. */
  accentSoft: string;
  /** accent @ 30% — glows behind the star and the primary button. */
  accentGlow: string;
  /** accent @ ~16-18% — the tinted chip fill ("you", "Notes ready"). */
  accentFill: string;
  /** oklch(0.70 0.16 24) dark · oklch(0.58 0.18 24) light — the record dot, risk. */
  hot: string;

  /** Flat colour under the screen gradient. */
  screenBase: string;
  /** Primary text. */
  ink: string;
  /** Secondary text (~60%). */
  ink2: string;
  /** Tertiary text / labels (~35%). */
  ink3: string;

  /** The standard glass fill. */
  glass: string;
  /** The raised glass fill (cards that sit above others). */
  glassHi: string;
  /** Hairline border on glass. */
  stroke: string;
  /** Stronger border — buttons, checkbox outlines. */
  stroke2: string;
  /** The inset top highlight that sells the glass edge. */
  sheen: string;

  /** Drop shadow, split into RN's separate shadow props. */
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffsetY: number;
  /** Android elevation approximating the same shadow. */
  elevation: number;
}

/** Dark is the mock's default theme. */
export const darkPalette: Palette = {
  accent: '#82a1f6',
  accent2: '#26c0cf',
  accentSoft: 'rgba(130,161,246,0.60)',
  accentGlow: 'rgba(130,161,246,0.30)',
  accentFill: 'rgba(130,161,246,0.18)',
  hot: '#f2716c',

  screenBase: '#06070d',
  ink: '#eef1f8',
  ink2: 'rgba(238,241,248,0.60)',
  ink3: 'rgba(238,241,248,0.34)',

  glass: 'rgba(255,255,255,0.055)',
  glassHi: 'rgba(255,255,255,0.10)',
  stroke: 'rgba(255,255,255,0.11)',
  stroke2: 'rgba(255,255,255,0.20)',
  sheen: 'rgba(255,255,255,0.14)',

  shadowColor: '#000000',
  shadowOpacity: 0.55,
  shadowRadius: 50,
  shadowOffsetY: 22,
  elevation: 12,
};

export const lightPalette: Palette = {
  accent: '#4f6dcc',
  // oklch(0.58 0.13 205) falls outside sRGB; this is the clipped conversion. It
  // reads as intended — flagged only so a future eye does not "correct" it back to
  // a value the display cannot show anyway.
  accent2: '#008f9f',
  accentSoft: 'rgba(79,109,204,0.60)',
  accentGlow: 'rgba(79,109,204,0.30)',
  accentFill: 'rgba(79,109,204,0.16)',
  hot: '#cf4042',

  screenBase: '#eceef5',
  ink: '#0e1118',
  ink2: 'rgba(14,17,24,0.62)',
  ink3: 'rgba(14,17,24,0.38)',

  glass: 'rgba(255,255,255,0.58)',
  glassHi: 'rgba(255,255,255,0.82)',
  stroke: 'rgba(255,255,255,0.85)',
  stroke2: 'rgba(14,17,24,0.10)',
  sheen: 'rgba(255,255,255,0.95)',

  shadowColor: '#0e1118',
  shadowOpacity: 0.14,
  shadowRadius: 44,
  shadowOffsetY: 18,
  elevation: 8,
};

/** The screen gradient stops, for `expo-linear-gradient` (mock `--screen`). */
export const screenGradient = {
  dark: ['#0a0d18', '#06070d', '#08070e'] as const,
  light: ['#f7f8fc', '#eceef5', '#e8eaf2'] as const,
};
/** Matching stop positions; the mock's 175deg reads as near-vertical in RN. */
export const screenGradientLocations = [0, 0.575, 1] as const;

/** Corner radii, named for what they wrap rather than by size. */
export const Radius = {
  /** The big content cards (mock 28 / 26 / 24). */
  card: 26,
  /** Secondary cards and list rows (mock 22). */
  cardSmall: 22,
  /** Search bar, inline panels (mock 18). */
  panel: 18,
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
 * Type scale, transcribed from the mock. The mock uses half-points freely
 * (13.5, 14.5); those are kept — RN accepts fractional sizes and rounding them
 * visibly changes the density the design depends on.
 */
export const FontSize = {
  screenTitle: 30,
  detailTitle: 27,
  callTitle: 23,
  suggestionHeadline: 17,
  cardTitle: 16.5,
  tldr: 15,
  body: 14.5,
  bodyTight: 14,
  label: 13.5,
  labelSmall: 13,
  meta: 12.5,
  metaSmall: 12,
  caption: 11.5,
  captionSmall: 11,
  monoChip: 10.5,
  eyebrow: 10,
} as const;

/** Font families. `system` is the fallback until `useNovaFonts` resolves. */
export const FontFamily = {
  sans: 'SplineSans_400Regular',
  sansMedium: 'SplineSans_500Medium',
  sansSemibold: 'SplineSans_600SemiBold',
  mono: 'SplineSansMono_400Regular',
} as const;

/**
 * The uppercase mono eyebrow used for every section label ("tl;dr", "decisions",
 * "grounded in"). One object because it appears a dozen times and drifting letter
 * spacing between them is immediately visible.
 */
export const eyebrowStyle = {
  fontFamily: FontFamily.mono,
  fontSize: FontSize.eyebrow,
  letterSpacing: 1.4,
  textTransform: 'uppercase',
} as const;

/** Spacing scale, in the increments the mock actually uses. */
export const Space = {
  xs: 4,
  sm: 7,
  md: 10,
  lg: 14,
  xl: 18,
  xxl: 26,
} as const;

/**
 * Resolve a palette from the RN colour scheme.
 *
 * Anything that is not explicitly `'light'` resolves to DARK — which covers `null`
 * (what `useColorScheme` returns before the system value arrives) and
 * `'unspecified'` (what it returns on a platform that has no preference). Dark is
 * the mock's default, so an unresolved scheme must not flash the light theme.
 *
 * The parameter is typed structurally rather than as RN's `ColorSchemeName` to keep
 * this module free of React Native imports — it is pure data, and pure data is
 * testable without a renderer.
 */
export function paletteFor(
  scheme: 'light' | 'dark' | 'unspecified' | null | undefined,
): Palette {
  return scheme === 'light' ? lightPalette : darkPalette;
}
