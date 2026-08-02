import { useRef } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { FontFamily, FontSize, Space, type Palette } from '@/design/tokens';
import { speakerTag } from '@/features/notes/transcript';
import type { LiveTranscriptTurn } from '@/hooks/use-live-session';

/**
 * The live transcript — what was just said
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4).
 *
 * The LATEST turn is full ink and the ones above it fade back, because this pane is
 * glanced at rather than read: the eye needs to land on the sentence that is still
 * in the air. Older lines stay legible (`inkSoft` is the ≥65% floor of spec §11) —
 * they are receding, not disabled.
 *
 * A `FlatList` (never `.map` in a ScrollView for unbounded data, RULES §10) that
 * follows the newest turn.
 */

/**
 * How far back a turn is, as ink. Newest full, the one before it soft, everything
 * older faint — three steps is all the depth a five-line pane can carry.
 */
export function turnInk(fromEnd: number, palette: Palette): string {
  if (fromEnd === 0) return palette.ink;
  if (fromEnd === 1) return palette.inkSoft;
  return palette.inkFaint;
}

export interface TranscriptTurnsProps {
  readonly turns: readonly LiveTranscriptTurn[];
  readonly palette: Palette;
}

export function TranscriptTurns({
  turns,
  palette,
}: TranscriptTurnsProps): React.JSX.Element {
  const listRef = useRef<FlatList<LiveTranscriptTurn>>(null);

  if (turns.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.placeholder, { color: palette.inkFaint }]}>
          What gets said lands here.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={turns as LiveTranscriptTurn[]}
      keyExtractor={(turn) => turn.id}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => {
        listRef.current?.scrollToEnd({ animated: true });
      }}
      renderItem={({ item, index }) => {
        const ink = turnInk(turns.length - 1 - index, palette);
        return (
          <View style={styles.turn}>
            {/* `speakerTag` is shared with the post-call transcript on purpose: a
                diarizer label names a VOICE, and rendering `spk_0` as THEM would
                assert something the pipeline never claimed. */}
            <Text style={[styles.tag, { color: palette.inkFaint }]}>
              {speakerTag(item.speaker) ?? '—'}
            </Text>
            <Text style={[styles.line, { color: ink }]}>{item.text}</Text>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Space.sm2,
    paddingVertical: Space.sm2,
  },
  turn: {
    flexDirection: 'row',
    gap: Space.md,
    alignItems: 'baseline',
  },
  tag: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
    width: 44,
  },
  line: {
    flex: 1,
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.45,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Space.lg,
  },
  placeholder: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
  },
});
