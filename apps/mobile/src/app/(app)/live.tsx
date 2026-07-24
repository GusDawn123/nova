import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { CopilotHistory } from '@/features/live-call/copilot-history';
import { TranscriptList } from '@/features/live-call/transcript-list';
import { useLiveSession } from '@/hooks/use-live-session';

/**
 * "Test Live" — the typed-question testing playground for the Phase 7 copilot
 * (renamed from "Live" 2026-07-23 so the real mic-driven Live screen of Phase
 * 8/9 can own that name; it will replace this playground at this same route).
 * Layout per Gustavo's 2026-07-22 direction: a COMPACT transcript strip on top,
 * the scrollable COPILOT HISTORY taking the majority below, and a
 * typed-question input at the bottom. Dumb: the `useLiveSession` hook owns the
 * socket, the meeting, and all state.
 *
 * "Start session" creates a meeting + connects the real authed socket; typing
 * a question sends `transcript.input` and the answer streams back as a REAL
 * LLM suggestion. Every suggestion on this screen is real — the canned replay
 * was removed 2026-07-23 at Gustavo's direction. Real mic capture is Phase 8/9.
 */
export default function LiveScreen() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const live = useLiveSession();
  const [draft, setDraft] = useState('');

  const send = (): void => {
    if (draft.trim() === '') return;
    live.sendInput(draft);
    setDraft('');
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <ThemedText type="title">Test Live</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {live.status}
            </ThemedText>
          </View>

          {/* Compact transcript strip — still visible, still scrollable. */}
          <ThemedView type="backgroundElement" style={styles.transcriptStrip}>
            <TranscriptList transcript={live.transcript} />
          </ThemedView>

          {/* The copilot history owns the majority of the screen. */}
          <CopilotHistory suggestions={live.suggestions} status={live.status} />

          {live.errorMessage !== null && (
            <ThemedText type="small" themeColor="textSecondary">
              {live.errorMessage}
            </ThemedText>
          )}

          {live.canSend ? (
            <View style={styles.inputRow}>
              <TextInput
                testID="live-input"
                style={[
                  styles.input,
                  {
                    color: colors.text,
                    backgroundColor: colors.backgroundElement,
                  },
                ]}
                placeholder="Ask a question…"
                placeholderTextColor={colors.textSecondary}
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={send}
                returnKeyType="send"
                multiline={false}
              />
              <Pressable
                testID="live-send-button"
                accessibilityRole="button"
                onPress={send}
                style={({ pressed }) => pressed && styles.pressed}>
                <ThemedView type="backgroundSelected" style={styles.sendButton}>
                  <ThemedText type="smallBold">Send</ThemedText>
                </ThemedView>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.actions}>
            {live.status === 'live' || live.status === 'connecting' ? (
              <Pressable
                testID="live-stop-button"
                accessibilityRole="button"
                onPress={() => live.stop()}
                style={({ pressed }) => pressed && styles.pressed}>
                <ThemedView
                  type="backgroundSelected"
                  style={styles.primaryButton}>
                  <ThemedText type="smallBold">End session</ThemedText>
                </ThemedView>
              </Pressable>
            ) : (
              <Pressable
                testID="live-start-button"
                accessibilityRole="button"
                onPress={() => void live.start()}
                style={({ pressed }) => pressed && styles.pressed}>
                <ThemedView
                  type="backgroundSelected"
                  style={styles.primaryButton}>
                  <ThemedText type="smallBold">Start session</ThemedText>
                </ThemedView>
              </Pressable>
            )}
          </View>
        </KeyboardAvoidingView>
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
    paddingHorizontal: Spacing.three,
  },
  flex: {
    flex: 1,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingTop: Spacing.two,
  },
  // COMPACT (Gustavo's direction): the transcript is a strip, not the star.
  transcriptStrip: {
    height: 120,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
  },
  inputRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    fontSize: FontSize.body,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    minHeight: 44,
  },
  sendButton: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    minHeight: 44,
    justifyContent: 'center',
  },
  actions: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
});
