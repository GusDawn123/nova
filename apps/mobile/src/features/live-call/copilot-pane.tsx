import { useRef } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { FontFamily, FontSize, Space, type Palette } from '@/design/tokens';
import type { LiveStatus, LiveSuggestion } from '@/hooks/use-live-session';

import { AnswerCard } from './answer-card';
import type { SteerPairing } from './steer-pairing';

/**
 * The copilot pane — the scrollable history of answers
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4).
 *
 * A HISTORY, not a replace-in-place panel (Gustavo's 2026-07-22 direction after sim
 * testing): every answer stays readable by scrolling back, and the newest sits at
 * the bottom where the eye already is.
 *
 * Auto-scroll is PINNED to the bottom while an answer streams — unless the user has
 * scrolled up to read an earlier one, in which case it never yanks them back down.
 * That behaviour survived a real bug (the queued `scrollToEnd` fighting an active
 * drag), and the shape below is the fix: the pin drops the instant a finger starts
 * dragging, and only `onScroll` returning to the bottom re-arms it.
 */

/** How close to the bottom (px) still counts as "pinned". */
const PIN_THRESHOLD_PX = 48;

/**
 * One card's worth of history.
 *
 * `key` rather than `id` because not every entry has a server id yet: a steer that
 * has been sent but whose answer has not started is drawn as a card immediately —
 * the wait is part of the answer, and the alternative is a press with no visible
 * consequence for a second and a half.
 */
export interface CopilotEntry {
  readonly key: string;
  readonly steer: string | null;
  readonly text: string;
  readonly streaming: boolean;
}

/**
 * The history as cards: the answers the server has sent, plus one card per steer
 * still waiting for its answer to start.
 *
 * Those waiting cards are the reason this is a function and not a `.map` at the call
 * site. A press has to have a visible consequence immediately — the wait is part of
 * the answer (spec §6) — and `suggestion.start` is a round trip away.
 */
export function copilotEntries(
  suggestions: readonly LiveSuggestion[],
  pairing: SteerPairing,
): CopilotEntry[] {
  return [
    ...suggestions.map((suggestion) => ({
      key: suggestion.id,
      steer: pairing.byId.get(suggestion.id) ?? null,
      text: suggestion.text,
      streaming: suggestion.streaming,
    })),
    ...pairing.pending.map((steer, index) => ({
      key: `pending-${String(index)}`,
      steer,
      text: '',
      streaming: true,
    })),
  ];
}

export interface CopilotPaneProps {
  readonly entries: readonly CopilotEntry[];
  readonly palette: Palette;
  readonly status: LiveStatus;
}

export function CopilotPane({
  entries,
  palette,
  status,
}: CopilotPaneProps): React.JSX.Element {
  const listRef = useRef<FlatList<CopilotEntry>>(null);
  // Ref, not state: scroll position must never trigger a render on its own.
  const pinnedRef = useRef(true);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    pinnedRef.current = distanceFromBottom < PIN_THRESHOLD_PX;
  };

  if (entries.length === 0) {
    return (
      <View testID="copilot-pane" style={[styles.pane, styles.empty]}>
        <Text style={[styles.placeholder, { color: palette.inkFaint }]}>
          {placeholderFor(status)}
        </Text>
      </View>
    );
  }

  return (
    <View testID="copilot-pane" style={styles.pane}>
      <FlatList
        ref={listRef}
        data={entries as CopilotEntry[]}
        keyExtractor={(entry) => entry.key}
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={16}
        // The instant a finger starts dragging, STOP following the stream —
        // waiting for the pin-distance check let scrollToEnd fight the drag and
        // yank the user back down mid-stream (Gustavo, 2026-07-23).
        onScrollBeginDrag={() => {
          pinnedRef.current = false;
        }}
        onContentSizeChange={() => {
          // New tokens/entries grow the content; follow only while pinned.
          // animated:false — queued animations also fought active touches.
          if (pinnedRef.current) {
            listRef.current?.scrollToEnd({ animated: false });
          }
        }}
        renderItem={({ item, index }) => (
          <AnswerCard
            palette={palette}
            steer={item.steer}
            text={item.text}
            streaming={item.streaming}
            newest={index === entries.length - 1}
          />
        )}
      />
    </View>
  );
}

/**
 * What an empty pane says. Total over the hook's status union, so a sixth state is a
 * type error rather than a blank pane — and none of these lines claims she is
 * listening for something she is not.
 */
function placeholderFor(status: LiveStatus): string {
  switch (status) {
    case 'connecting':
      return 'Opening the line…';
    case 'live':
      return 'Answers land here. Type a steer and press RESPOND.';
    case 'error':
      return 'Nothing came back.';
    case 'closed':
      return 'That was the whole call.';
    case 'idle':
      return 'Start a session and she starts listening.';
  }
}

const styles = StyleSheet.create({
  pane: { flex: 1 },
  content: {
    gap: Space.md,
    paddingVertical: Space.md,
  },
  empty: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: Space.xl,
  },
  placeholder: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.5,
    textAlign: 'center',
  },
});
