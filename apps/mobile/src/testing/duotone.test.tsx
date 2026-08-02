import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { cobaltPalette } from '@/design/tokens';

import { expectDuotoneOnly, normaliseColor } from './duotone';

/**
 * The guard's own guard.
 *
 * `expectDuotoneOnly` is the only mechanical enforcement spec §11 has — every screen
 * suite leans on it — so the thing that actually matters about it is that it FAILS.
 * A guard that reads four of the six surfaces a colour can arrive through is worse
 * than no guard, because the two it misses are the ones nobody checks by eye.
 *
 * So there is one breach per surface below, each written the way the real breach
 * would be written: an accent border on one side, a gradient stop, a shadow.
 *
 * The probes are plain DOM rather than react-native-web views on purpose. The guard
 * walks the DOM, the breaches it must catch are DOM-level, and a `<div>` states the
 * case in one line where a `<View>` would need a style-prop escape hatch to express
 * an off-palette value at all.
 */

const OFF_PALETTE = '#d7263d';
/**
 * The same colour, either spelling: a hex assigned through the style OBJECT comes
 * back from jsdom as `rgb()`, while one buried in a gradient or shadow string
 * survives verbatim.
 */
const OFF_MATCH = /d7263d|215,\s*38,\s*61/i;
const INK = cobaltPalette.ink;
const FILL = cobaltPalette.inkFill;

function guard(ui: React.JSX.Element): () => void {
  const { container } = render(ui);
  return () => {
    expectDuotoneOnly(container, cobaltPalette);
  };
}

describe('normaliseColor', () => {
  it('gives one spelling per colour', () => {
    expect(normaliseColor('#0002DA')).toBe(normaliseColor('rgb(0, 2, 218)'));
    expect(normaliseColor('rgba(255,255,255,0.10)')).toBe(
      normaliseColor('rgba(255, 255, 255, 0.1)'),
    );
    // A fully opaque rgba IS an rgb — notation must not decide the answer.
    expect(normaliseColor('rgba(0,2,218,1)')).toBe(normaliseColor('#0002DA'));
  });
});

describe('expectDuotoneOnly — what it lets through', () => {
  it('passes a tree painted only in ink and canvas', () => {
    expect(
      guard(
        <div style={{ backgroundColor: cobaltPalette.canvas }}>
          <div style={{ color: INK, borderLeft: `2px solid ${cobaltPalette.inkHairline}` }}>
            ink text
          </div>
          <div
            style={{
              backgroundImage: `linear-gradient(180deg, ${FILL} 0%, transparent 100%)`,
              boxShadow: `0 2px 8px ${FILL}`,
            }}
          />
          <svg>
            <defs>
              <radialGradient id="probe-glow">
                <stop offset="0" stopColor={INK} stopOpacity={0.16} />
                <stop offset="1" stopColor={INK} stopOpacity={0} />
              </radialGradient>
            </defs>
            <circle cx={5} cy={5} r={5} fill="url(#probe-glow)" stroke={INK} />
          </svg>
        </div>,
      ),
    ).not.toThrow();
  });

  it('is not fooled by notation', () => {
    // The token file writes `rgba(255,255,255,0.10)`; the browser reports
    // `rgba(255, 255, 255, 0.1)`; a hand-written sweep might say `#fff`.
    expect(
      guard(
        <div style={{ color: '#ffffff', backgroundColor: 'rgba(255, 255, 255, 0.100)' }}>
          same white, three spellings
        </div>,
      ),
    ).not.toThrow();
  });
});

describe('expectDuotoneOnly — what it catches', () => {
  it('an off-palette text colour', () => {
    expect(guard(<div style={{ color: OFF_PALETTE }}>error</div>)).toThrow(OFF_MATCH);
  });

  it('an off-palette background', () => {
    expect(guard(<div style={{ backgroundColor: OFF_PALETTE }} />)).toThrow(OFF_MATCH);
  });

  it('an off-palette border on ANY side, not just the top', () => {
    // The reason all four sides are read: an accent stripe down one edge is the
    // most natural way to sneak a second colour into a card.
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      expect(
        guard(
          <div
            style={{
              [`border${side}Width`]: 3,
              [`border${side}Style`]: 'solid',
              [`border${side}Color`]: OFF_PALETTE,
            }}
          />,
        ),
        `border ${side}`,
      ).toThrow(OFF_MATCH);
    }
  });

  it('an off-palette gradient stop', () => {
    // Spec §2 permits gradients as light sweeps — it does not permit their stops to
    // be any colour they like.
    expect(
      guard(
        <div
          style={{
            backgroundImage: `linear-gradient(180deg, ${INK} 0%, ${OFF_PALETTE} 100%)`,
          }}
        />,
      ),
    ).toThrow(OFF_MATCH);
  });

  it('an off-palette SVG gradient stop', () => {
    // This is the mascot's glow and the tear track: the colour is on the stop, not
    // on any fill or stroke attribute.
    expect(
      guard(
        <svg>
          <defs>
            <radialGradient id="probe-bad">
              <stop offset="0" stopColor={OFF_PALETTE} />
            </radialGradient>
          </defs>
          <circle cx={5} cy={5} r={5} fill="url(#probe-bad)" />
        </svg>,
      ),
    ).toThrow(OFF_MATCH);
  });

  it('an off-palette svg fill or stroke', () => {
    expect(guard(<svg><rect fill={OFF_PALETTE} /></svg>)).toThrow(OFF_MATCH);
    expect(guard(<svg><rect stroke={OFF_PALETTE} /></svg>)).toThrow(OFF_MATCH);
  });

  it('an off-palette shadow', () => {
    expect(guard(<div style={{ boxShadow: `0 2px 8px ${OFF_PALETTE}` }} />)).toThrow(OFF_MATCH);
    expect(
      guard(<div style={{ textShadow: `0 1px 2px ${OFF_PALETTE}` }}>glow</div>),
    ).toThrow(OFF_MATCH);
  });

  it('a colour that hides behind its name', () => {
    // `crimson` is no more allowed than `#dc143c`, and a grep for hexes would miss it.
    expect(guard(<div style={{ color: 'crimson' }}>named</div>)).toThrow(/crimson/i);
  });
});
