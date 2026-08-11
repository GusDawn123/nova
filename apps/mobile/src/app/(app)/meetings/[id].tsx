import type { ConversationType, MeetingNotes, NotesStatus } from '@nova/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

import { FontFamily, FontSize, Size, Space, type Palette } from '@/design/tokens';
import { DetailTabs, type DetailTab } from '@/features/meetings/detail-tabs';
import { formatRelativeDay, formatStartTime } from '@/features/meetings/format';
import { StateCard } from '@/features/meetings/state-card';
import {
  NO_NOTES_TO_DRAFT_FROM,
  NOTES_NOT_READY_TO_DRAFT_FROM,
  type FollowUpFailure,
} from '@/features/notes/follow-up';
import { FollowUpPanel } from '@/features/notes/follow-up-panel';
import { NotesView } from '@/features/notes/notes-view';
import { TranscriptPanel } from '@/features/notes/transcript-panel';
import { usePalette } from '@/hooks/use-appearance';
import { useMeetingNotes } from '@/hooks/use-meeting-notes';
import { useMeetingTranscript } from '@/hooks/use-meeting-transcript';

/**
 * The meeting detail (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5):
 * back eyebrow, title block, three chamfered tabs, and one view at a time.
 *
 * The rule the states are built around is that a broken notes pipeline must not
 * take the call with it. Notes folding, notes failed, notes never written — the
 * transcript tab stays open in all three, because the transcript is the thing that
 * actually happened and the notes are only what was made of it.
 *
 * The header is FIXED and each panel scrolls itself. That is not a style choice: the
 * transcript is a `FlatList` (hundreds of turns is unbounded data, RULES §10) and
 * nesting one inside a screen-level ScrollView is the virtualization bug that
 * warning is about.
 *
 * Dumb, as before: `useMeetingNotes` owns the read and the optimistic checkbox
 * write, `useMeetingTranscript` owns the lazy transcript read, and everything drawn
 * here is a function of their state.
 */

/**
 * A route param is external input: `id` arrives as `string | string[] | undefined`,
 * and `meetingListItemSchema.id` is a uuid. Parsed, not asserted — an array or a
 * missing value would otherwise be interpolated straight into a fetch URL.
 */
const meetingIdSchema = z.string().uuid();

/** The meta line's type segment. A `Record`, so a fourth type fails to compile. */
const TYPE_LABELS: Record<ConversationType, string> = {
  sales: 'SALES',
  interview: 'INTERVIEW',
  casual: 'CASUAL',
};

export default function MeetingDetailScreen(): React.JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const parsedId = meetingIdSchema.safeParse(id);
  const meetingId = parsedId.success ? parsedId.data : null;

  const [tab, setTab] = useState<DetailTab>('notes');
  const { state, completedIds, toggleItem, refresh } =
    useMeetingNotes(meetingId);
  // Lazy by the tab: most opens of a meeting never read the transcript, and it is
  // the longest thing this API returns.
  const transcript = useMeetingTranscript(meetingId, tab === 'transcript');

  // The clock is read ONCE per open. A screen left in the foreground across
  // midnight would otherwise keep calling yesterday "today" — and unlike the list,
  // this screen has no focus event to re-read on.
  const [now] = useState(() => new Date());

  /**
   * The eyebrow says `‹ MEETINGS`, so it has to GO to the meetings list — and there
   * is no history to pop when the screen was reached by a deep link, a notification
   * tap, or a cold start on this route. `router.back()` alone is a dead control in
   * every one of those cases.
   */
  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const read = state.status === 'success' ? state.data : null;
  const notes = read?.notes ?? null;
  const errorMessage = state.status === 'error' ? state.message : null;
  const loading = state.status === 'loading';

  const title = notes?.title ?? null;
  const meta = metaLine(notes, read?.notes_generated_at ?? null, now);

  if (meetingId === null) {
    // Nothing was fetched, so every branch below is inert: this is the whole screen
    // for a link that does not name a meeting.
    return (
      <Screen palette={palette} insets={insets}>
        <BackEyebrow palette={palette} onPress={goBack} />
        <StateCard
          palette={palette}
          testID="detail-unavailable"
          eyebrow="MEETING"
          message="This call isn't available."
          detail="That link doesn't point to a call we can open. Go back and pick it from your list."
        />
      </Screen>
    );
  }

  return (
    <Screen palette={palette} insets={insets}>
      <BackEyebrow palette={palette} onPress={goBack} />

      {/* Both lines are OMITTED when unknown rather than filled in. The title lives
          on the notes and this wire carries no other copy of it, so a call whose
          notes failed has no title here — and "Untitled call" would be this screen
          asserting one. The back eyebrow and the tabs already say where you are. */}
      {title === null && meta === '' ? null : (
        <View style={styles.titleBlock}>
          {title === null ? null : (
            <Text
              testID="detail-title"
              style={[styles.title, { color: palette.ink }]}
            >
              {title}
            </Text>
          )}
          {meta === '' ? null : (
            <Text
              testID="detail-meta"
              style={[styles.meta, { color: palette.inkSoft }]}
            >
              {meta}
            </Text>
          )}
        </View>
      )}

      <DetailTabs tab={tab} onSelect={setTab} palette={palette} />

      <View style={styles.panel}>
        {tab === 'notes' ? (
          <NotesView
            palette={palette}
            notes={notes}
            status={read?.notes_status ?? null}
            errorMessage={errorMessage}
            loading={loading}
            completedIds={completedIds}
            onToggleItem={toggleItem}
            onRetry={refresh}
          />
        ) : null}

        {tab === 'transcript' ? (
          <TranscriptPanel
            state={transcript.state}
            palette={palette}
            onRetry={transcript.retry}
          />
        ) : null}

        {tab === 'follow-up' ? (
          <FollowUpPanel
            draft={read?.follow_up ?? null}
            failure={followUpFailure(read?.notes_status ?? null)}
            // The read's own state is threaded in the same way `NotesView` takes
            // it: without it the panel's empty card would say "nothing failed"
            // over a read that is still in flight, or one that failed outright.
            loading={loading}
            errorMessage={errorMessage}
            onRetry={refresh}
            palette={palette}
          />
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * The follow-up's failure, derived from what this screen actually knows.
 *
 * The draft is written FROM the notes, so the notes' status is the whole answer —
 * and the two halves of it are NOT the same sentence. Notes still coming are a wait
 * ("it will be here"); notes that failed, or a call from before Nova wrote any, are
 * a dead end, and telling that user to sit tight is a promise nothing will keep.
 *
 * Switched exhaustively rather than defaulted, so a sixth `NotesStatus` is a type
 * error here instead of quietly inheriting whichever sentence came last.
 *
 * `null` means the read has not produced a status — loading or errored — and those
 * two are handled by the panel itself, ahead of this.
 */
function followUpFailure(status: NotesStatus | null): FollowUpFailure | null {
  switch (status) {
    case null:
    case 'completed':
      return null;
    case 'queued':
    case 'processing':
      // The named constant, not a hand-written 409: this screen never made that
      // request, and quoting a status it did not receive invites the next reader to
      // believe it did.
      return NOTES_NOT_READY_TO_DRAFT_FROM;
    case 'failed':
    case 'none':
      return NO_NOTES_TO_DRAFT_FROM;
  }
}

/**
 * The mono line under the title.
 *
 * It says what the read model can PROVE. `GET /meetings/:id/notes` carries no call
 * start, end or duration — only the moment the notes were written — so the line is
 * labelled `NOTES` rather than printed as a bare time that a reader would take for
 * the call's own clock. Showing the call's start and length is a wire change, not a
 * presentation one.
 */
function metaLine(
  notes: MeetingNotes | null,
  generatedAt: string | null,
  now: Date,
): string {
  const day = formatRelativeDay(generatedAt, now);
  const time = formatStartTime(generatedAt);

  return [
    notes === null ? null : TYPE_LABELS[notes.conversationType],
    day === null || time === null
      ? null
      : `NOTES ${day.toUpperCase()} ${time.toUpperCase()}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** `‹ MEETINGS` — the way back, in the mono register the rest of the chrome uses. */
function BackEyebrow({
  palette,
  onPress,
}: {
  palette: Palette;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      testID="back-button"
      accessibilityRole="button"
      accessibilityLabel="Back to meetings"
      onPress={onPress}
      style={({ pressed }) => [styles.back, pressed ? styles.pressed : undefined]}
    >
      <Text style={[styles.backLabel, { color: palette.inkSoft }]}>
        ‹ MEETINGS
      </Text>
    </Pressable>
  );
}

function Screen({
  palette,
  insets,
  children,
}: {
  palette: Palette;
  insets: { top: number; bottom: number };
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.root, { backgroundColor: palette.canvas }]}>
      <View
        style={[
          styles.frame,
          {
            paddingTop: insets.top + Space.md,
            paddingBottom: insets.bottom + Space.md,
          },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  frame: {
    flex: 1,
    paddingHorizontal: Space.xl,
    gap: Space.lg,
  },
  // A real 44pt box rather than `hitSlop`: react-native-web ignores hitSlop, and
  // Expo Web is this project's verification target. The eyebrow stays a whisper; the
  // target does not.
  back: {
    alignSelf: 'flex-start',
    minHeight: Size.tapTarget,
    justifyContent: 'center',
    paddingVertical: Space.sm,
  },
  backLabel: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    letterSpacing: 2,
  },
  titleBlock: { gap: Space.xs2 },
  title: {
    fontFamily: FontFamily.bodySemibold,
    fontSize: FontSize.displayLg,
    letterSpacing: -0.4,
    lineHeight: FontSize.displayLg * 1.15,
  },
  meta: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
    letterSpacing: 1,
  },
  // The panel takes the rest of the screen and scrolls inside it, which is what
  // keeps the header from scrolling away under a long transcript.
  panel: { flex: 1 },
  pressed: { opacity: 0.7 },
});
