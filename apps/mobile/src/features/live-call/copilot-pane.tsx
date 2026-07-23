import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { LiveStatus, LiveSuggestion } from '@/hooks/use-live-session';

/**
 * The single FIXED streaming copilot pane (design: live-pipeline.md §Mobile — the
 * overlay mental model, one place to glance under stress; NOT a stack of cards).
 * Dumb: it renders whatever `useLiveSession` hands it. First tokens are visible
 * the instant they arrive (the hook flushes the ref buffer here); the body is
 * plain text while streaming and upgrades once on `done`.
 */
export function CopilotPane({
  suggestion,
  status,
}: {
  suggestion: LiveSuggestion | null;
  status: LiveStatus;
}) {
  return (
    <ThemedView type="backgroundElement" style={styles.pane}>
      <View style={styles.header}>
        <ThemedText type="smallBold" themeColor="textSecondary">
          Copilot
        </ThemedText>
        {suggestion?.streaming ? (
          <ThemedText type="small" themeColor="textSecondary">
            {suggestion.kind}…
          </ThemedText>
        ) : null}
      </View>

      {suggestion ? (
        <ThemedText type="default" style={styles.body}>
          {suggestion.text || '…'}
        </ThemedText>
      ) : (
        <ThemedText type="default" themeColor="textSecondary" style={styles.body}>
          {placeholderFor(status)}
        </ThemedText>
      )}
    </ThemedView>
  );
}

function placeholderFor(status: LiveStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'live':
      return 'Listening — suggestions appear here.';
    case 'error':
      return 'Connection error.';
    case 'closed':
      return 'Session ended.';
    case 'idle':
      return 'Not started.';
  }
}

const styles = StyleSheet.create({
  pane: {
    minHeight: 140,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  body: {
    lineHeight: 22,
  },
});
