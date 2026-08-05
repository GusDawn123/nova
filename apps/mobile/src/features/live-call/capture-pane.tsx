import { StyleSheet, Text, View } from 'react-native';

import {
  FontFamily,
  FontSize,
  Radius,
  Size,
  Space,
  type Palette,
} from '@/design/tokens';
import type { LiveTranscriptTurn } from '@/hooks/use-live-session';

import { TranscriptTurns } from './transcript-turns';

/**
 * The capture pane: the soft card under the header
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4 — transcript pane).
 *
 * SOFT corners and no chamfer: it is read, not pressed (spec §3). It is a strip
 * rather than the star of the screen — the copilot pane below it is what the user
 * is actually looking at — so it shows the last few turns and gets out of the way.
 *
 * It once carried a second tab for the live-notes preview; that feature was
 * removed 2026-08-04 (see `docs/DESIGN/live-notes.md`'s banner), so the card is
 * now what the design mock always drew: the transcript strip, with a static
 * label in the same mono voice the tab label used.
 */

export interface CapturePaneProps {
  readonly turns: readonly LiveTranscriptTurn[];
  readonly palette: Palette;
}

export function CapturePane({
  turns,
  palette,
}: CapturePaneProps): React.JSX.Element {
  return (
    <View
      testID="capture-pane"
      style={[styles.card, { backgroundColor: palette.inkFill }]}
    >
      <View style={styles.labelRow}>
        <Text
          testID="capture-label-transcript"
          style={[styles.label, { color: palette.ink }]}
        >
          TRANSCRIPT
        </Text>
      </View>

      <TranscriptTurns turns={turns} palette={palette} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    // Tall enough for the label row plus a few transcript lines (the height the
    // tabbed version established; the layout around it depends on it).
    height: 174,
    borderRadius: Radius.soft,
    paddingHorizontal: Space.lg,
    paddingBottom: Space.sm2,
  },
  // Keeps the label vertically centered in the same band the 44pt tab row
  // occupied, so the transcript below it does not shift.
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: Size.tapTarget,
  },
  label: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
  },
});
