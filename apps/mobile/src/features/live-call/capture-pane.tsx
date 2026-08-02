import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  FontFamily,
  FontSize,
  Radius,
  Size,
  Space,
  type Palette,
} from '@/design/tokens';
import type { LiveNotesState } from '@/features/notes/notes-update';
import type { LiveTranscriptTurn } from '@/hooks/use-live-session';

import { LiveNotesPanel } from './live-notes-panel';
import { TranscriptTurns } from './transcript-turns';

/**
 * The capture pane: the soft card under the header
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4 — transcript pane).
 *
 * SOFT corners and no chamfer: it is read, not pressed (spec §3). It is a strip
 * rather than the star of the screen — the copilot pane below it is what the user
 * is actually looking at — so it shows the last few turns and gets out of the way.
 *
 * TABBED, which the design mock's transcript-only card is not: live notes need a
 * home during the call (`docs/DESIGN/notes-ui.md` §5.1, already built and wired
 * through `useLiveSession`), and the redesign is a re-skin of this screen, not a
 * removal of what it does. Both panels stay MOUNTED so the hidden one keeps
 * receiving updates — an unread dot is meaningless if the tab has to be open for
 * anything to arrive.
 */

export type CaptureTab = 'transcript' | 'notes';

/** Copy in one place; a third tab fails to compile until it has a label. */
const TAB_LABELS: Record<CaptureTab, string> = {
  transcript: 'TRANSCRIPT',
  notes: 'LIVE NOTES',
};

const TAB_ORDER: readonly CaptureTab[] = ['transcript', 'notes'];

export interface CapturePaneProps {
  readonly tab: CaptureTab;
  readonly onSelect: (tab: CaptureTab) => void;
  readonly turns: readonly LiveTranscriptTurn[];
  readonly notes: LiveNotesState;
  readonly palette: Palette;
}

export function CapturePane({
  tab,
  onSelect,
  turns,
  notes,
  palette,
}: CapturePaneProps): React.JSX.Element {
  return (
    <View
      testID="capture-pane"
      style={[styles.card, { backgroundColor: palette.inkFill }]}
    >
      <View accessibilityRole="tablist" style={styles.tabs}>
        {TAB_ORDER.map((value) => {
          const selected = value === tab;
          return (
            <Pressable
              key={value}
              testID={`capture-tab-${value}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              // `aria-selected` alongside accessibilityState: react-native-web
              // renders the aria-* props as real DOM attributes, and that is the
              // only channel a screen reader has on the web target.
              aria-selected={selected}
              onPress={() => {
                onSelect(value);
              }}
              style={({ pressed }) => [
                styles.tab,
                pressed ? styles.pressed : undefined,
              ]}
            >
              <Text
                style={[
                  styles.tabLabel,
                  { color: selected ? palette.ink : palette.inkFaint },
                ]}
              >
                {TAB_LABELS[value]}
              </Text>
              {value === 'notes' && notes.hasUnseen ? (
                <View
                  testID="notes-unread-dot"
                  style={[styles.dot, { backgroundColor: palette.ink }]}
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {tab === 'transcript' ? (
        <TranscriptTurns turns={turns} palette={palette} />
      ) : (
        <ScrollView contentContainerStyle={styles.notes}>
          <LiveNotesPanel state={notes} palette={palette} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    height: 156,
    borderRadius: Radius.soft,
    paddingHorizontal: Space.lg,
    paddingBottom: Space.sm2,
  },
  tabs: {
    flexDirection: 'row',
    gap: Space.lg,
    alignItems: 'center',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs2,
    minHeight: Size.tapTarget - Space.xl,
    justifyContent: 'center',
  },
  tabLabel: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
  },
  dot: { width: Size.dot, height: Size.dot, borderRadius: Radius.pill },
  notes: { paddingBottom: Space.sm2 },
  pressed: { opacity: 0.7 },
});
