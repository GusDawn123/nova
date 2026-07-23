import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { CopilotPane } from '@/features/live-call/copilot-pane';
import { LIVE_DEMO_FIXTURE } from '@/features/live-call/demo-fixture';
import { TranscriptList } from '@/features/live-call/transcript-list';
import { useLiveSession, type LiveReplayStep } from '@/hooks/use-live-session';

/**
 * Minimal live-copilot screen (Phase 7). Dumb: `useLiveSession` owns the socket
 * and all state; this composes the scrolling transcript (flex) above the FIXED
 * copilot pane. Real mic capture is Phase 8/9, so this drives the pane from a
 * REPLAY fixture (a fresh array per press retriggers the hook) — the same reducer
 * the real socket feeds, proving deltas append, start replaces, discard clears.
 */
export default function LiveScreen() {
  // A new array identity per "Start" press restarts the replay effect.
  const [replay, setReplay] = useState<readonly LiveReplayStep[] | undefined>(
    undefined,
  );
  const { status, transcript, suggestion } = useLiveSession({ replay });

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <ThemedText type="title" style={styles.title}>
          Live
        </ThemedText>

        <ThemedView type="backgroundElement" style={styles.transcriptRegion}>
          <TranscriptList transcript={transcript} />
        </ThemedView>

        <CopilotPane suggestion={suggestion} status={status} />

        <Pressable
          testID="live-demo-button"
          accessibilityRole="button"
          onPress={() => setReplay([...LIVE_DEMO_FIXTURE])}
          style={({ pressed }) => pressed && styles.pressed}>
          <ThemedView type="backgroundSelected" style={styles.button}>
            <ThemedText type="smallBold">
              {status === 'connecting' ? 'Replaying…' : 'Replay demo call'}
            </ThemedText>
          </ThemedView>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  title: {
    paddingTop: Spacing.two,
  },
  transcriptRegion: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  button: {
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
});
