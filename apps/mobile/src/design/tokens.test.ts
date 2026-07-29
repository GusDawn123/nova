import { describe, expect, it } from 'vitest';

import {
  darkPalette,
  lightPalette,
  paletteFor,
  eyebrowStyle,
  type Palette,
} from './tokens';

/**
 * Token guards (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.1).
 *
 * These do not assert that a colour is pretty — that is Gustavo's eye on the
 * simulator. They assert the things a theme regression actually breaks: that both
 * palettes define the same keys (a missing token renders as `undefined`, which RN
 * treats as "no style" and shows as invisible text rather than an error), and that
 * the scheme resolver defaults the way the app assumes.
 */

const KEYS = Object.keys(darkPalette) as (keyof Palette)[];

describe('palettes', () => {
  it('define exactly the same keys in both themes', () => {
    // A token present in one theme and missing in the other is the classic dark-mode
    // bug: it renders fine in the theme you developed in and disappears in the other.
    expect(Object.keys(lightPalette).sort()).toEqual([...KEYS].sort());
  });

  it.each(KEYS)('defines %s in both themes with no empty values', (key) => {
    for (const palette of [darkPalette, lightPalette]) {
      const value = palette[key];
      expect(value).toBeDefined();
      if (typeof value === 'string') expect(value.length).toBeGreaterThan(0);
      else expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('gives the two themes genuinely different ink and surfaces', () => {
    // Guards a copy-paste that leaves light using dark's values.
    expect(lightPalette.ink).not.toBe(darkPalette.ink);
    expect(lightPalette.glass).not.toBe(darkPalette.glass);
    expect(lightPalette.accent).not.toBe(darkPalette.accent);
  });
});

describe('paletteFor', () => {
  it('returns light only for an explicit light scheme', () => {
    expect(paletteFor('light')).toBe(lightPalette);
  });

  it('defaults to dark for dark, null, and undefined', () => {
    // RN's useColorScheme returns null before the system value resolves. Dark is the
    // mock's default, so an unresolved scheme must not flash the light theme.
    expect(paletteFor('dark')).toBe(darkPalette);
    expect(paletteFor(null)).toBe(darkPalette);
    expect(paletteFor(undefined)).toBe(darkPalette);
  });
});

describe('eyebrowStyle', () => {
  it('is uppercase mono with tracking — the mock uses it a dozen times', () => {
    expect(eyebrowStyle.textTransform).toBe('uppercase');
    expect(eyebrowStyle.letterSpacing).toBeGreaterThan(0);
    expect(eyebrowStyle.fontFamily).toContain('Mono');
  });
});
