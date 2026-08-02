import { describe, expect, it } from 'vitest';

import {
  BRAND_BLUE,
  BRAND_WHITE,
  Chamfer,
  FontFamily,
  cobaltPalette,
  paperPalette,
  paletteFor,
  eyebrowStyle,
  type Palette,
} from './tokens';

/**
 * Token guards (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §9).
 *
 * These do not assert that a colour is pretty — that is Gustavo's eye on the
 * simulator. They assert the things a theme regression actually breaks: that both
 * palettes define the same keys (a missing token renders as `undefined`, which RN
 * treats as "no style" and shows as invisible text rather than an error), that the
 * two themes really are mirrors of the two brand constants, and that the scheme
 * resolver defaults the way the app assumes.
 */

const KEYS = Object.keys(cobaltPalette) as (keyof Palette)[];

describe('palettes', () => {
  it('define exactly the same keys in both themes', () => {
    // A token present in one theme and missing in the other is the classic dark-mode
    // bug: it renders fine in the theme you developed in and disappears in the other.
    expect(Object.keys(paperPalette).sort()).toEqual([...KEYS].sort());
  });

  it.each(KEYS)('defines %s in both themes with no empty values', (key) => {
    for (const palette of [cobaltPalette, paperPalette]) {
      const value = palette[key];
      expect(value).toBeDefined();
      if (typeof value === 'string') expect(value.length).toBeGreaterThan(0);
      else expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('gives the two themes genuinely different ink and surfaces', () => {
    // Guards a copy-paste that leaves paper using cobalt's values.
    expect(paperPalette.ink).not.toBe(cobaltPalette.ink);
    expect(paperPalette.canvas).not.toBe(cobaltPalette.canvas);
    expect(paperPalette.inkFill).not.toBe(cobaltPalette.inkFill);
  });

  it('carries no colour that is not one of the two brand constants', () => {
    // The duotone rule (spec §11): every colour token is blue or white, at full
    // strength or at a stated opacity. A third colour must fail here.
    const themes = [
      { name: 'cobalt', palette: cobaltPalette, rgb: '255,255,255' },
      { name: 'paper', palette: paperPalette, rgb: '0,2,218' },
    ];
    for (const { name, palette, rgb } of themes) {
      for (const key of KEYS) {
        const value = palette[key];
        if (typeof value !== 'string') continue;
        const isDuotone =
          value === BRAND_BLUE ||
          value === BRAND_WHITE ||
          value.startsWith(`rgba(${rgb},`);
        expect(isDuotone, `${name}.${key} is ${value}`).toBe(true);
      }
    }
  });
});

describe('paletteFor', () => {
  it('returns light only for an explicit light scheme', () => {
    expect(paletteFor('light')).toBe(paperPalette);
  });

  it('defaults to dark for dark, null, undefined, and unspecified', () => {
    // useColorScheme returns null before the system value resolves and
    // 'unspecified' where the platform has no preference. Dark is the mock's
    // default, so neither may flash the light theme.
    expect(paletteFor('dark')).toBe(cobaltPalette);
    expect(paletteFor(null)).toBe(cobaltPalette);
    expect(paletteFor(undefined)).toBe(cobaltPalette);
    expect(paletteFor('unspecified')).toBe(cobaltPalette);
  });
});

describe('the duotone', () => {
  it('cobalt and paper are exact mirrors of the two brand constants', () => {
    const cobalt = paletteFor('dark');
    const paper = paletteFor('light');
    expect(cobalt.canvas).toBe(BRAND_BLUE);
    expect(cobalt.ink).toBe('#FFFFFF');
    expect(paper.canvas).toBe('#FFFFFF');
    expect(paper.ink).toBe(BRAND_BLUE);
    expect(cobalt.onInk).toBe(cobalt.canvas);
    expect(paper.onInk).toBe(paper.canvas);
  });

  it('derived opacities stay in the declared bands', () => {
    for (const p of [paletteFor('dark'), paletteFor('light')]) {
      expect(p.inkFill).toMatch(/0\.10?\)$/);
      expect(p.inkHairline).toMatch(/0\.35\)$/);
    }
  });

  it('the font trio is the brand trio', () => {
    expect(FontFamily.display).toBe('Orbitron_900Black');
    expect(FontFamily.body).toBe('Inter_400Regular');
    expect(FontFamily.mono).toBe('SpaceMono_400Regular');
    expect(Chamfer.control).toBe(8);
  });
});

describe('eyebrowStyle', () => {
  it('is uppercase mono with tracking — the mock uses it a dozen times', () => {
    expect(eyebrowStyle.textTransform).toBe('uppercase');
    expect(eyebrowStyle.letterSpacing).toBeGreaterThan(0);
    expect(eyebrowStyle.fontFamily).toContain('Mono');
  });
});
