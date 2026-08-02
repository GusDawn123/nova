import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FontFamily, cobaltPalette } from '@/design/tokens';
import { reanimatedSpies } from '@/testing/reanimated-stub';

import { StreamingText } from './streaming-text';

/**
 * The teleprompter renderer
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6, "Text arrival —
 * CRISP TERMINAL").
 *
 * Four things carry the design and are worth pinning: the text LAGS the props and
 * catches up (that lag is the whole effect), the caret is the completion signal and
 * therefore may never be orphaned in either direction, `**bold**` reaches the reader
 * as weight rather than as punctuation, and reduced motion delivers the same words
 * with no cadence at all.
 *
 * Everything below runs on fake timers, because the drain underneath is a 16ms tick
 * loop — real timers would make every assertion a race.
 */
vi.mock('react-native-reanimated', async () => {
  const { reanimatedStub } = await import('@/testing/reanimated-stub');
  return reanimatedStub();
});

/**
 * `useReducedMotion` is mocked rather than driven through `AccessibilityInfo`: the
 * real store caches its value for the life of the module by design (see `motion.ts`),
 * so a test that flipped the OS setting would leak into every test after it.
 */
const reduced = vi.hoisted(() => ({ value: false }));

vi.mock('@/design/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/design/motion')>()),
  useReducedMotion: () => reduced.value,
}));

const INK = cobaltPalette.ink;

beforeEach(() => {
  vi.useFakeTimers();
  reduced.value = false;
  reanimatedSpies.withRepeat.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Drive the drain's tick loop and let React flush what it produced. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** What a reader would actually see. The caret carries no text of its own. */
function visible(): string {
  return screen.getByTestId('stream-text').textContent ?? '';
}

/**
 * The `font-family` an element's classes declare.
 *
 * NOT `getComputedStyle`: react-native-web's base text class carries a `font:`
 * shorthand, and jsdom's cascade lets that shorthand beat the more specific
 * `font-family` class that RNW generates for the style prop — so the computed value
 * reads back as the system stack (or as `""` on a nested span) however the component
 * is styled, and the assertion would pass on a bold span that is not bold. Reading
 * the declaration off the sheet, last match winning as the cascade would, asks the
 * question that actually has an answer here.
 */
function declaredFontFamily(element: Element): string {
  let declared = '';
  for (const sheet of [...document.styleSheets]) {
    for (const rule of [...sheet.cssRules]) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (!element.classList.contains(rule.selectorText.replace(/^\./, ''))) {
        continue;
      }
      const family = rule.style.getPropertyValue('font-family');
      if (family !== '') declared = family;
    }
  }

  return declared;
}

describe('StreamingText — cadence', () => {
  it('lags the text it is handed, then catches up', () => {
    const line = 'Honestly, because the problems were the same.';
    const { rerender } = render(
      <StreamingText text={line.slice(0, 20)} done={false} color={INK} />,
    );

    // The first frame is the caret alone, at the write-head.
    expect(visible()).toBe('');

    advance(50);
    const early = visible();
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(20); // a hand writing, not a paste
    expect(line.startsWith(early)).toBe(true);

    rerender(<StreamingText text={line} done={false} color={INK} />);
    advance(3000);

    expect(visible()).toBe(line);
  });

  it('loses nothing when the text grows several times between frames', () => {
    // Deltas land faster than the drain empties, so two or three growths commit
    // before a single character is drawn. The diff has to be against what was
    // HANDED to the drain, not against what is on screen.
    const { rerender } = render(
      <StreamingText text="Take the " done={false} color={INK} />,
    );
    rerender(<StreamingText text="Take the meeting " done={false} color={INK} />);
    rerender(<StreamingText text="Take the meeting and ask." done color={INK} />);

    advance(3000);

    expect(visible()).toBe('Take the meeting and ask.');
  });

  it('starts over when the new text is not an extension of the old', () => {
    // CONSTRAINT: a shorter or diverged `text` is a NEW stream reusing the
    // component, not an edit — the old line goes immediately rather than being
    // overwritten character by character.
    const first = 'Ask for the raise.';
    const { rerender } = render(
      <StreamingText text={first} done color={INK} />,
    );
    advance(2000);
    expect(visible()).toBe(first);

    const second = 'Different answer entirely.';
    rerender(<StreamingText text={second} done={false} color={INK} />);

    expect(visible()).toBe('');
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
    advance(3000);
    expect(visible()).toBe(second);
  });
});

describe('StreamingText — the caret is the completion signal', () => {
  it('holds the caret up while text is still arriving', () => {
    const line = 'Ask for the raise.';
    const { rerender } = render(
      <StreamingText text={line} done={false} color={INK} />,
    );

    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
    expect(reanimatedSpies.withRepeat).toHaveBeenCalled(); // it blinks

    advance(2000);
    expect(visible()).toBe(line);
    // Drained, but upstream has not said it finished: the caret stays.
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();

    rerender(<StreamingText text={line} done color={INK} />);
    advance(100);

    expect(screen.queryByTestId('stream-caret')).toBeNull();
  });

  it('keeps the caret until the drain catches up, not when `done` arrives', () => {
    const line = 'x'.repeat(300);
    render(<StreamingText text={line} done color={INK} />);

    advance(100);
    expect(visible().length).toBeGreaterThan(0);
    expect(visible().length).toBeLessThan(line.length);
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();

    advance(5000);
    expect(visible()).toBe(line);
    expect(screen.queryByTestId('stream-caret')).toBeNull();
  });

  it('takes `done` in the same commit as the last of the text', () => {
    // The ordinary ending: the final delta and the done event batch into one
    // render. Push first, end second — the other order truncates the answer.
    const line = 'Offer the number and stop talking.';
    const { rerender } = render(
      <StreamingText text={line.slice(0, 10)} done={false} color={INK} />,
    );
    rerender(<StreamingText text={line} done color={INK} />);

    advance(3000);

    expect(visible()).toBe(line);
    expect(screen.queryByTestId('stream-caret')).toBeNull();
  });

  it('drops text that arrives after `done` rather than reopening the caret', () => {
    // CONSTRAINT, inherited from the drain: once the caret has vanished nothing may
    // appear after it. Text growing after `done` is an upstream ordering bug, and
    // silently truncating it is less damaging than a completion signal that lies.
    const line = 'Ask for it.';
    const { rerender } = render(<StreamingText text={line} done color={INK} />);
    advance(2000);
    expect(screen.queryByTestId('stream-caret')).toBeNull();

    rerender(<StreamingText text={`${line} And more.`} done color={INK} />);
    advance(2000);

    expect(visible()).toBe(line);
    expect(screen.queryByTestId('stream-caret')).toBeNull();
  });

  it('paints the caret as a block in the ink it was handed', () => {
    render(<StreamingText text="Ask" done={false} color={INK} />);

    const caret = screen.getByTestId('stream-caret');
    expect(getComputedStyle(caret).width).toBe('7px');
    expect(getComputedStyle(caret).height).toBe('15px');
    expect(getComputedStyle(caret).backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('does not interrupt the sentence it is sitting in', () => {
    // THE DECORATIVE RULING (`design/decorative.ts`), and the case with the most to
    // lose by it: the caret is an inline block INSIDE the paragraph, so left visible
    // to assistive tech it lands in the middle of the text being read. What it means
    // — "still arriving" — a reader gets from the text changing under it anyway.
    render(<StreamingText text="Ask" done={false} color={INK} />);

    expect(screen.getByTestId('stream-caret')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('leaves no timer running when it unmounts mid-stream', () => {
    const { unmount } = render(
      <StreamingText text={'x'.repeat(300)} done={false} color={INK} />,
    );
    advance(100);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('StreamingText — bold', () => {
  it('renders **bold** in Inter 700 and never shows the markers', () => {
    render(
      <StreamingText text="Offer **$47,500** flat" done color={INK} />,
    );
    advance(2000);

    expect(visible()).toBe('Offer $47,500 flat');
    expect(declaredFontFamily(screen.getByText('$47,500'))).toBe(
      FontFamily.bodyBold,
    );
    expect(declaredFontFamily(screen.getByTestId('stream-text'))).toBe(
      FontFamily.body,
    );
  });

  it('opens a bold run on an unterminated marker instead of showing it', () => {
    // Mid-stream, `**` with no partner yet means "bold from here" — it is not
    // punctuation the reader should ever see, and showing it would reflow the line
    // when the closer lands one tick later.
    render(<StreamingText text="Offer **$47,500" done={false} color={INK} />);
    advance(2000);

    expect(visible()).toBe('Offer $47,500');
    expect(declaredFontFamily(screen.getByText('$47,500'))).toBe(
      FontFamily.bodyBold,
    );
  });

  it('never shows half of a ** marker on its way past', () => {
    // The drain cuts wherever the tick lands, so it splits a `**` about half the
    // times one appears — a lone asterisk for a frame, on most suggestions.
    const line = 'Offer **$47,500** and hold there, **firmly**.';
    render(<StreamingText text={line} done color={INK} />);

    for (let tick = 0; tick < 120; tick += 1) {
      advance(16);
      expect(visible()).not.toContain('*');
    }

    expect(visible()).toBe('Offer $47,500 and hold there, firmly.');
  });
});

describe('StreamingText — reduced motion', () => {
  it('delivers the whole line at once, with no drain running', () => {
    reduced.value = true;
    const line = 'Honestly, because the problems were the same.';

    const { rerender } = render(
      <StreamingText text={line} done={false} color={INK} />,
    );

    // No timer has advanced: the words are simply there.
    expect(visible()).toBe(line);
    expect(vi.getTimerCount()).toBe(0);
    // The caret still says "not finished" — it just does not blink.
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
    expect(reanimatedSpies.withRepeat).not.toHaveBeenCalled();

    rerender(<StreamingText text={line} done color={INK} />);

    expect(screen.queryByTestId('stream-caret')).toBeNull();
    expect(visible()).toBe(line);
  });

  it('does not rewind the line when the setting is switched off mid-stream', () => {
    // The reduced render shows the whole `text`, so the drain's bookkeeping has to
    // move with it. Without that, flipping the setting back mid-call would drop the
    // reader to a half-drained prefix of what they had already read — or re-stream
    // the words they already have.
    reduced.value = true;
    const line = 'Honestly, because the problems were the same.';
    const { rerender } = render(
      <StreamingText text={line} done={false} color={INK} />,
    );
    expect(visible()).toBe(line);

    reduced.value = false;
    rerender(<StreamingText text={`${line} Say it plainly.`} done color={INK} />);

    expect(visible()).toBe(line);
    // `done` arrived in that same commit, but sixteen characters have NOT. Carrying
    // the completion over on `done` alone drops the caret here and streams the rest
    // of the sentence with no write-head at all.
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
    // Mid-flight, not just at the end: the new drain has to pick up FROM the words
    // already on screen. A drain that starts at zero also finishes with the whole
    // line, having rewound the reader to nothing on the way.
    advance(50);
    expect(visible().startsWith(line)).toBe(true);
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
    advance(3000);
    expect(visible()).toBe(`${line} Say it plainly.`);
    expect(screen.queryByTestId('stream-caret')).toBeNull();
  });

  it('does not carry a finished stream over onto the one that replaced it', () => {
    // The stale-completion path. An answer finishes, the setting goes on, and a NEW
    // answer arrives while it is on — so the divergence that should have reset the
    // completion never gets tested, because the reduced branch answered first. Switch
    // the setting off and the new stream renders start to finish with no caret,
    // permanently, with nothing left to correct it.
    const first = 'Ask for the raise.';
    const { rerender } = render(<StreamingText text={first} done color={INK} />);
    advance(2000);
    expect(screen.queryByTestId('stream-caret')).toBeNull();

    reduced.value = true;
    rerender(<StreamingText text={first} done color={INK} />);

    const second = 'Different answer entirely.';
    rerender(<StreamingText text={second} done={false} color={INK} />);
    expect(visible()).toBe(second);
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();

    reduced.value = false;
    rerender(<StreamingText text={second} done={false} color={INK} />);

    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
    advance(2000);
    expect(visible()).toBe(second);
    expect(screen.getByTestId('stream-caret')).toBeInTheDocument();
  });

  it('does not flash the caret back onto an answer that already finished', () => {
    // Switching the setting off after the answer landed hands a finished stream to a
    // brand-new drain, which needs a tick to agree that it is finished. The caret is
    // the ONLY completion signal, so a frame of it reappearing says she started
    // writing again.
    reduced.value = true;
    const line = 'Ask for the raise.';
    const { rerender } = render(<StreamingText text={line} done color={INK} />);
    expect(screen.queryByTestId('stream-caret')).toBeNull();

    reduced.value = false;
    rerender(<StreamingText text={line} done color={INK} />);

    expect(screen.queryByTestId('stream-caret')).toBeNull();
    expect(visible()).toBe(line);
    advance(1000);
    expect(screen.queryByTestId('stream-caret')).toBeNull();
    expect(visible()).toBe(line);
  });

  it('shuts the drain down when the setting is switched on mid-stream', () => {
    const line = 'Honestly, because the problems were the same.';
    const { rerender } = render(
      <StreamingText text={line} done={false} color={INK} />,
    );
    advance(50);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    reduced.value = true;
    rerender(<StreamingText text={line} done={false} color={INK} />);

    // The rest of the words arrive at once, and the tick loop that was writing them
    // is gone rather than left running behind a render that ignores it.
    expect(visible()).toBe(line);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still renders bold spans without their markers', () => {
    reduced.value = true;

    render(<StreamingText text="Offer **$47,500** flat" done color={INK} />);

    expect(visible()).toBe('Offer $47,500 flat');
    expect(declaredFontFamily(screen.getByText('$47,500'))).toBe(
      FontFamily.bodyBold,
    );
  });
});
