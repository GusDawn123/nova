import { useRef } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { LiveStatus, LiveSuggestion } from '@/hooks/use-live-session';

/**
 * The COPILOT HISTORY (decision 2026-07-22, Gustavo's direction after sim
 * testing): the majority region of the live screen, a chat-log of suggestions.
 * A new `suggestion.start` APPENDS an entry (the hook owns that mapping); this
 * component renders the list and pins auto-scroll to the bottom while streaming
 * — UNLESS the user has scrolled up to read an earlier answer, in which case it
 * never yanks them back down. Dumb: renders whatever `useLiveSession` hands it.
 */

/** How close to the bottom (px) still counts as "pinned". */
const PIN_THRESHOLD_PX = 48;

export function CopilotHistory({
  suggestions,
  status,
}: {
  suggestions: readonly LiveSuggestion[];
  status: LiveStatus;
}) {
  const listRef = useRef<FlatList<LiveSuggestion>>(null);
  // Ref, not state: scroll position must never trigger a render on its own.
  const pinnedRef = useRef(true);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    pinnedRef.current = distanceFromBottom < PIN_THRESHOLD_PX;
  };

  if (suggestions.length === 0) {
    return (
      <ThemedView type="backgroundElement" style={[styles.region, styles.empty]}>
        <ThemedText type="default" themeColor="textSecondary">
          {placeholderFor(status)}
        </ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView type="backgroundElement" style={styles.region}>
      <FlatList
        ref={listRef}
        data={suggestions as LiveSuggestion[]}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          // New tokens/entries grow the content; follow only while pinned.
          if (pinnedRef.current) {
            listRef.current?.scrollToEnd({ animated: true });
          }
        }}
        renderItem={({ item }) => (
          <View style={styles.entry}>
            <View style={styles.entryHeader}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                {item.kind}
              </ThemedText>
              {item.streaming ? (
                <ThemedText type="small" themeColor="textSecondary">
                  streaming…
                </ThemedText>
              ) : null}
            </View>
            <ThemedText type="default" style={styles.entryBody}>
              {item.text || '…'}
            </ThemedText>
          </View>
        )}
      />
    </ThemedView>
  );
}

function placeholderFor(status: LiveStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'live':
      return 'Listening — ask a question below or start talking.';
    case 'error':
      return 'Something went wrong.';
    case 'closed':
      return 'Session ended.';
    case 'idle':
      return 'Start a session to get live suggestions.';
  }
}

const styles = StyleSheet.create({
  region: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  content: {
    gap: Spacing.three,
    paddingVertical: Spacing.three,
  },
  empty: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.four,
  },
  entry: {
    gap: Spacing.one,
  },
  entryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  entryBody: {
    lineHeight: 22,
  },
});
