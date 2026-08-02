import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { tabBarClearance } from '@/design/tab-bar-metrics';
import { CopilotHistory } from '@/features/live-call/copilot-history';
import { LiveNotesPanel } from '@/features/live-call/live-notes-panel';
import { ModePicker } from '@/features/live-call/mode-picker';
import { TranscriptList } from '@/features/live-call/transcript-list';
import { usePalette } from '@/hooks/use-appearance';
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
 *
 * The MODE PICKER above the capture strip chooses which prompt answers this call
 * (General / Behavioral / Technical / Finance). It is a pre-call choice: the
 * server locks the mode at `session.start`, so the row is inert while a session
 * is connecting or live — `useLiveSession` owns both the pick and that lock.
 */
export default function LiveScreen() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  // The capture strip is TABBED (§5.1): live notes need a home during the call,
  // and the design prototype's card is transcript-only.
  const [captureTab, setCaptureTab] = useState<'transcript' | 'notes'>(
    'transcript',
  );
  const live = useLiveSession({ notesPanelVisible: captureTab === 'notes' });
  const [draft, setDraft] = useState('');

  const send = (): void => {
    if (draft.trim() === '') return;
    live.sendInput(draft);
    setDraft('');
  };

  const showNotes = (): void => {
    setCaptureTab('notes');
    // Revealing the panel is what clears the dot — not the update that set it.
    live.markNotesSeen();
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView
        style={[
          styles.safeArea,
          // The tab bar floats (position: absolute) and reserves no layout space,
          // so this screen has to leave room or the action row hides under it.
          { paddingBottom: tabBarClearance(insets.bottom) },
        ]}
        edges={['top']}
      >
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <ThemedText type="title">Test Live</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {live.status}
            </ThemedText>
          </View>

          {/* Which prompt answers this call. Locked once it starts. */}
          <ModePicker
            mode={live.mode}
            onSelect={live.setMode}
            disabled={!live.canPickMode}
          />

          {/* Tabbed capture strip (§5.1): Transcript | Live notes. Both panels
              stay mounted so the hidden one keeps receiving updates — the unread
              dot is meaningless if the tab has to be open to hear anything. */}
          <View accessibilityRole="tablist" style={styles.captureTabs}>
            <Pressable
              accessibilityRole="tab"
              // `aria-selected` alongside accessibilityState: react-native-web
              // renders the aria-* props as DOM attributes, which is the only way
              // the current tab is announced on the web target.
              accessibilityState={{ selected: captureTab === 'transcript' }}
              aria-selected={captureTab === 'transcript'}
              onPress={() => {
                setCaptureTab('transcript');
              }}
            >
              <ThemedText
                type={captureTab === 'transcript' ? 'smallBold' : 'small'}
                themeColor={
                  captureTab === 'transcript' ? 'text' : 'textSecondary'
                }
              >
                Transcript
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: captureTab === 'notes' }}
              aria-selected={captureTab === 'notes'}
              onPress={showNotes}
              style={styles.notesTab}
            >
              <ThemedText
                type={captureTab === 'notes' ? 'smallBold' : 'small'}
                themeColor={captureTab === 'notes' ? 'text' : 'textSecondary'}
              >
                Live notes
              </ThemedText>
              {live.liveNotes.hasUnseen ? (
                <View style={[styles.unreadDot, { backgroundColor: palette.hot }]} />
              ) : null}
            </Pressable>
          </View>

          <ThemedView type="backgroundElement" style={styles.transcriptStrip}>
            {captureTab === 'transcript' ? (
              <TranscriptList transcript={live.transcript} />
            ) : (
              <ScrollView>
                <LiveNotesPanel state={live.liveNotes} palette={palette} />
              </ScrollView>
            )}
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
                placeholder="Type what they said…"
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
  captureTabs: {
    flexDirection: 'row',
    gap: Spacing.four,
    alignItems: 'center',
    paddingHorizontal: Spacing.two,
  },
  notesTab: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  unreadDot: { width: 7, height: 7, borderRadius: 4 },
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
