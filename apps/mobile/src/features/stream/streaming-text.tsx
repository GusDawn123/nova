import { Fragment, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';

import { useReducedMotion } from '@/design/motion';
import { FontFamily, FontSize } from '@/design/tokens';

import { createStreamDrain, type StreamDrain } from './drain';

/**
 * The teleprompter renderer — "Text arrival, CRISP TERMINAL"
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §6).
 *
 * It is handed the WHOLE accumulated answer on every render and shows only as much
 * of it as the drain has released, with a block caret at the write-head. The lag is
 * the point: socket deltas land in ~50ms lumps, and drawing them as they arrive reads
 * as stuttering paste rather than as someone writing.
 *
 * **The caret vanishing IS the completion signal** (spec §6) — there is no separate
 * done indicator anywhere in this design. That makes the caret's lifetime the one
 * thing this component must never get wrong, in either direction: it may not leave
 * while characters are still coming, and it may not linger once they have stopped.
 * So it is unmounted on the drain's own `onDone` rather than on a `drained === text`
 * comparison — the drain is the only thing that knows its buffer is empty, and the
 * comparison would hang the caret forever on any text the drain declined to accept.
 *
 * No palette is imported for the ink: `color` arrives from the caller, which already
 * knows its theme — the contract `ChamferSurface` and `LightSweep` keep.
 */

/** Caret block: 7pt wide, one body line tall. Sized to sit ON the write-head. */
const CARET_WIDTH = 7;
const CARET_HEIGHT = FontSize.body;
/** One full blink. A hard square wave — a fading caret reads as a glow, not a cursor. */
const CARET_BLINK_MS = 900;

/**
 * The blink: on for half a period, off for half, forever.
 *
 * Gated exactly like `useShimmer` in `motion.ts` — the hook is called unconditionally
 * (Reanimated requires that) and the infinite `withRepeat` is what reduced motion
 * switches off, leaving a steady block. Steady is right: the caret still carries the
 * "not finished" meaning when it cannot move.
 *
 * Written here rather than reusing `motion.ts::useCaret` because that one is the
 * legacy notes-UI partial-transcript cursor at a different period (1000ms), and its
 * trough is a dim 0.1 rather than off. Both will not survive the redesign; this one
 * is the redesign's.
 */
function useCaretBlink(): AnimatedStyle<ViewStyle> {
  const on = useSharedValue(1);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      on.value = 1;
      return;
    }
    on.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 0 }),
        withDelay(CARET_BLINK_MS / 2, withTiming(0, { duration: 0 })),
        withDelay(CARET_BLINK_MS / 2, withTiming(1, { duration: 0 })),
      ),
      -1,
      false,
    );
  }, [on, reduced]);

  // Explicit deps rather than the Babel plugin's inference: Reanimated requires one
  // or the other, and only this form also renders where the plugin does not run.
  return useAnimatedStyle(() => ({ opacity: on.value }), [on]);
}

function Caret({ color }: { color: string }): React.JSX.Element {
  const blink = useCaretBlink();

  // An inline View inside Text is what puts the block ON the write-head rather than
  // at the end of the paragraph box; it needs the explicit size it has above.
  return (
    <Animated.View
      style={[styles.caret, { backgroundColor: color }, blink]}
      testID="stream-caret"
    />
  );
}

interface Segment {
  readonly bold: boolean;
  readonly text: string;
}

/**
 * Split on `**` markers. Only `**` — the server's format rules emit markdown bold,
 * and everything else it emits is the copilot pane's problem, not the renderer's.
 *
 * CONSTRAINT — an UNTERMINATED `**` opens a bold run that reaches the end of the
 * text. Mid-stream that is exactly what it means, and the alternative (rendering the
 * literal asterisks until the closer lands, as the legacy
 * `features/live-call/markdown-lite.tsx` does) flashes markup at the reader and then
 * reflows the line one tick later. Markers are never characters here.
 */
function toBoldSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let bold = false;

  for (;;) {
    const marker = text.indexOf('**', cursor);
    const end = marker === -1 ? text.length : marker;
    if (end > cursor) segments.push({ bold, text: text.slice(cursor, end) });
    if (marker === -1) break;
    bold = !bold;
    cursor = marker + 2;
  }

  return segments;
}

/**
 * Hide the first half of a `**` the drain has only half-delivered.
 *
 * The drain cuts wherever its tick lands, so it splits a marker on roughly half the
 * ones it carries — and a `*` is not a character the reader is ever meant to see.
 * Only a trailing `*` with another `*` waiting behind it in the source qualifies; a
 * genuine asterisk at the end of the delivered text stays.
 */
function withoutSplitMarker(shown: string, source: string): string {
  return shown.endsWith('*') && source.charAt(shown.length) === '*'
    ? shown.slice(0, -1)
    : shown;
}

export interface StreamingTextProps {
  /** The accumulated text so far — grows as deltas arrive. */
  text: string;
  /** Upstream says the stream completed. */
  done: boolean;
  /** Ink, for both the glyphs and the caret. */
  color: string;
  /** Type style overrides — size, line height, where the block sits. */
  style?: StyleProp<TextStyle>;
}

export function StreamingText({
  text,
  done,
  color,
  style,
}: StreamingTextProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const [drained, setDrained] = useState('');
  const [complete, setComplete] = useState(false);
  /** Bumped when the props describe a NEW stream; the drain follows it. */
  const [generation, setGeneration] = useState(0);
  /** The props this component has already reacted to. */
  const [seen, setSeen] = useState({ text, reduced });

  const drainRef = useRef<StreamDrain | null>(null);
  /** Mirrors `drained` where an effect can read it without depending on it. */
  const drainedRef = useRef('');
  /** Everything handed to the CURRENT drain — what the growth diff runs against. */
  const pushedRef = useRef('');
  const generationRef = useRef(generation);

  // ---------------------------------------------------------------------------
  // Prop-derived state, adjusted DURING RENDER
  // ---------------------------------------------------------------------------
  // React's documented shape for "state that has to change when a prop changes"
  // (You Might Not Need an Effect). It re-renders immediately with the corrected
  // value and never commits the stale one, where the same work in an effect would
  // paint the wrong thing for a frame first and cascade a second commit per delta.
  // The effect below is left owning only the drain, which is what effects are for:
  // an external system with a lifetime.
  if (seen.text !== text || seen.reduced !== reduced) {
    setSeen({ text, reduced });
    if (reduced) {
      // The reduced render shows `text` whole, so the drained bookkeeping catches up
      // to it: switching the setting back mid-stream must not rewind the screen to a
      // half-drained prefix of what has already been read.
      if (drained !== text) setDrained(text);
    } else if (!text.startsWith(seen.text)) {
      // CONSTRAINT — a `text` that no longer EXTENDS the last one is a NEW stream
      // reusing the component (the next suggestion, a reconnect, a mode switch), not
      // an edit of the old one. It resets: the old line goes at once and the new one
      // writes itself from the first character. Diffing instead would overwrite a
      // longer line in place, which reads as corruption rather than as a new answer.
      setDrained('');
      setComplete(false);
      setGeneration(generation + 1);
    } else if (seen.reduced && drained !== seen.text) {
      // Motion has just come back on. Every word delivered whole while it was off
      // stays where it is and the drain resumes from there — the alternative rewinds
      // the reader to nothing and re-writes what they have already read.
      setDrained(seen.text);
    }
  }

  useEffect(() => {
    // A new stream: drop the old drain and everything it was still holding. Keyed on
    // the generation rather than re-deriving "is this a reset?" here, so the decision
    // is made in exactly one place.
    if (generationRef.current !== generation) {
      generationRef.current = generation;
      drainRef.current?.dispose();
      drainRef.current = null;
      drainedRef.current = '';
      pushedRef.current = '';
    }

    if (reduced) {
      drainRef.current?.dispose();
      drainRef.current = null;
      drainedRef.current = text;
      pushedRef.current = text;
      return;
    }

    let drain = drainRef.current;
    if (drain === null) {
      drain = createStreamDrain({
        onText: (chunk) => {
          drainedRef.current += chunk;
          setDrained(drainedRef.current);
        },
        onDone: () => {
          setComplete(true);
        },
      });
      drainRef.current = drain;
      // A fresh drain holds nothing, so the screen is what it has to catch up from —
      // anything the disposed one was still holding gets pushed again below.
      pushedRef.current = drainedRef.current;
    }

    const suffix = text.slice(pushedRef.current.length);
    if (suffix.length > 0) {
      pushedRef.current = text;
      drain.push(suffix);
    }
    // Push first, end second, in this order and in this same effect: the drain DROPS
    // anything pushed after `end()`, so the reverse order truncates the answer.
    if (done) drain.end();
  }, [done, generation, reduced, text]);

  // Unmount only. Deliberately NOT the cleanup of the effect above — that one re-runs
  // on every delta, and disposing per delta would restart the cadence continuously.
  useEffect(
    () => () => {
      drainRef.current?.dispose();
      drainRef.current = null;
    },
    [],
  );

  // Reduced motion reads `text` straight off the props rather than through the
  // drained state: on the FIRST render of a mounted component nothing has adjusted
  // anything yet, and someone who asked for no motion should not get an empty frame
  // as their introduction to the answer.
  const shown = withoutSplitMarker(reduced ? text : drained, text);
  const showCaret = reduced ? !done : !complete;

  return (
    <Text style={[styles.text, { color }, style]} testID="stream-text">
      {toBoldSegments(shown).map((segment, index) =>
        segment.bold ? (
          <Text key={index} style={styles.bold}>
            {segment.text}
          </Text>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
      {showCaret ? <Caret color={color} /> : null}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontFamily: FontFamily.body, fontSize: FontSize.body },
  // Weight is a FACE here, not a `fontWeight`: Inter ships as separate files and a
  // synthetic bold would not match the loaded 700.
  bold: { fontFamily: FontFamily.bodyBold },
  caret: { width: CARET_WIDTH, height: CARET_HEIGHT },
});
