import { FlatList, StyleSheet, Text, View } from 'react-native';

import { FontFamily, FontSize, Space, type Palette } from '@/design/tokens';
import { StateCard } from '@/features/meetings/state-card';
import type { MeetingTranscriptState } from '@/hooks/use-meeting-transcript';

import {
  formatCallClock,
  groupTranscriptBySpeaker,
  speakerTag,
  type TranscriptBlock,
} from './transcript';

/**
 * The Transcript view (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5):
 * the record of what was said, tagged `me` / `them` in mono.
 *
 * A `FlatList`, not a mapped column: a 90-minute call is hundreds of turns, and this
 * is exactly the unbounded data RULES §10 forbids putting in a ScrollView. It is
 * also why this panel scrolls itself rather than living inside a screen-level
 * scroller — nesting the two is the bug that virtualization warning is about.
 *
 * The two states that look alike and mean opposite things are kept apart on purpose:
 * an EMPTY transcript is a real answer (a call where nobody spoke), a failure is not.
 */

export interface TranscriptPanelProps {
  readonly state: MeetingTranscriptState;
  readonly palette: Palette;
}

export function TranscriptPanel({
  state,
  palette,
}: TranscriptPanelProps): React.JSX.Element {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <StateCard
        palette={palette}
        testID="transcript-loading"
        eyebrow="TRANSCRIPT"
        message="Fetching what was said."
        waiting
      />
    );
  }

  if (state.status === 'error') {
    return (
      <StateCard
        palette={palette}
        testID="transcript-error"
        eyebrow="TRANSCRIPT"
        message="The transcript didn’t come back"
        detail={state.message}
      />
    );
  }

  if (state.turns.length === 0) {
    return (
      <StateCard
        palette={palette}
        testID="transcript-empty"
        eyebrow="TRANSCRIPT"
        message="Nothing was recorded on this call."
        detail="No speech reached Nova while it was listening."
      />
    );
  }

  const blocks = groupTranscriptBySpeaker(state.turns);

  return (
    <FlatList
      testID="transcript-panel"
      data={blocks}
      // Index, deliberately: a block has no id of its own, and its position in a
      // finished transcript never changes.
      keyExtractor={(_, index) => String(index)}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      renderItem={({ item }) => <Turn block={item} palette={palette} />}
    />
  );
}

function Turn({
  block,
  palette,
}: {
  block: TranscriptBlock;
  palette: Palette;
}): React.JSX.Element {
  const tag = speakerTag(block.speaker);
  const clock = formatCallClock(block.tsMs);

  return (
    <View style={styles.turn}>
      {tag === null && clock === null ? null : (
        <View style={styles.tagRow}>
          {tag === null ? null : (
            <Text style={[styles.tag, { color: palette.ink }]}>{tag}</Text>
          )}
          {clock === null ? null : (
            <Text style={[styles.clock, { color: palette.inkFaint }]}>
              {clock}
            </Text>
          )}
        </View>
      )}
      {block.lines.map((line, index) => (
        <Text
          key={`${String(index)}:${line}`}
          style={[styles.line, { color: palette.inkSoft }]}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Space.lg,
    paddingBottom: Space.xxl,
  },
  turn: { gap: Space.xs2 },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm2,
  },
  tag: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
  },
  clock: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
  },
  line: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodySm,
    lineHeight: FontSize.bodySm * 1.5,
  },
});
