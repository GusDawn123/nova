import { useRef } from 'react';
import { FlatList, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { LiveTranscriptTurn } from '@/hooks/use-live-session';

/**
 * The scrolling live transcript — SEPARATE from the fixed copilot pane (design:
 * live-pipeline.md §Mobile). A `FlatList` (never `.map` in a ScrollView for
 * unbounded data, RULES §10) that autoscrolls to the newest final turn.
 */
export function TranscriptList({
  transcript,
}: {
  transcript: readonly LiveTranscriptTurn[];
}) {
  const listRef = useRef<FlatList<LiveTranscriptTurn>>(null);

  if (transcript.length === 0) {
    return (
      <ThemedView style={styles.empty}>
        <ThemedText type="small" themeColor="textSecondary">
          Transcript will appear here as people speak.
        </ThemedText>
      </ThemedView>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={transcript as LiveTranscriptTurn[]}
      keyExtractor={(turn) => turn.id}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      renderItem={({ item }) => (
        <ThemedText type="small" style={styles.turn}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            {item.speaker ?? 'them'}:{' '}
          </ThemedText>
          {item.text}
        </ThemedText>
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  turn: {
    lineHeight: 20,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.four,
  },
});
