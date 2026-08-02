import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

import { GlassPill, GlassSurface } from '@/design/glass';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  paletteFor,
  type Palette,
} from '@/design/tokens';
import { statusToPill } from '@/features/meetings/format';
import { NotesPanel } from '@/features/notes/notes-panel';
import { useMeetingNotes } from '@/hooks/use-meeting-notes';

/**
 * A route param is external input: `id` arrives as `string | string[] | undefined`,
 * and `meetingListItemSchema.id` is a uuid. Parsed, not asserted — an array or a
 * missing value would otherwise be interpolated straight into a fetch URL.
 */
const meetingIdSchema = z.string().uuid();

/**
 * The meeting detail screen (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.2).
 *
 * Pushed on the `(app)` stack rather than living in the tab navigator, so the tab
 * bar's two pills stay as drawn.
 *
 * The read model already prefers post-call `notes` and falls back to `live_notes`,
 * so this screen never asks which it got — that fallback is exactly what makes a
 * still-folding call openable, showing notes that fill in as the pipeline runs.
 *
 * The Follow-up and Transcript tabs are slice 8; this ships the Notes tab.
 */
export default function MeetingDetailScreen(): React.JSX.Element {
  const scheme = useColorScheme();
  const palette = paletteFor(scheme);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const parsedId = meetingIdSchema.safeParse(id);
  const meetingId = parsedId.success ? parsedId.data : null;
  const { state, completedIds, toggleItem, refresh } =
    useMeetingNotes(meetingId);

  const notes =
    state.status === 'success'
      ? (state.data.notes ?? state.data.live_notes)
      : null;
  const pill =
    state.status === 'success' ? statusToPill(state.data.notes_status) : null;

  return (
    <View style={[styles.root, { backgroundColor: palette.canvas }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + Space.md,
            paddingBottom: insets.bottom + Space.xxl,
          },
        ]}
      >
        <View style={styles.topRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            testID="back-button"
            onPress={() => {
              router.back();
            }}
          >
            <GlassPill palette={palette} style={styles.backButton}>
              <Text style={[styles.backGlyph, { color: palette.ink }]}>
                {'‹'}
              </Text>
            </GlassPill>
          </Pressable>
          {pill !== null ? (
            <Text style={[styles.statusMeta, { color: palette.ink3 }]}>
              {pill.label}
            </Text>
          ) : null}
        </View>

        {notes !== null ? (
          <>
            <View style={styles.titleBlock}>
              <Text style={[styles.title, { color: palette.ink }]}>
                {notes.title}
              </Text>
              {/* Say plainly when this is the running preview rather than the
                  finished notes — the two look identical otherwise, and the user
                  should know which one they are reading. */}
              {state.status === 'success' && state.data.notes === null ? (
                <Text style={[styles.subtitle, { color: palette.ink3 }]}>
                  Notes are still being written — this updates as the call is
                  processed.
                </Text>
              ) : null}
            </View>
            <NotesPanel
              notes={notes}
              palette={palette}
              completedIds={completedIds}
              onToggleItem={toggleItem}
            />
          </>
        ) : null}

        {meetingId === null ? (
          // Nothing was fetched, so every branch below is inert: this is the whole
          // screen for a link that does not name a meeting.
          <StateCard
            palette={palette}
            title="This meeting is not available"
            body="That link does not point to a call we can open. Go back and pick the call from your list."
          />
        ) : state.status === 'loading' ? (
          <Text style={[styles.message, { color: palette.ink3 }]}>
            Loading notes…
          </Text>
        ) : null}

        {state.status === 'error' ? (
          <StateCard
            palette={palette}
            title="Could not load these notes"
            body={state.message}
            action={{ label: 'Try again', onPress: refresh }}
          />
        ) : null}

        {state.status === 'success' && notes === null ? (
          <StateCard
            palette={palette}
            title={
              state.data.notes_status === 'failed'
                ? 'Notes could not be generated'
                : 'No notes yet'
            }
            body={
              state.data.notes_status === 'failed'
                ? 'Something went wrong while writing the notes for this call. You can ask Nova to try again.'
                : 'Notes appear here once the call has been processed.'
            }
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function StateCard({
  palette,
  title,
  body,
  action,
}: {
  palette: Palette;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}): React.JSX.Element {
  return (
    <GlassSurface palette={palette} style={styles.stateCard} elevated>
      <Text style={[styles.stateTitle, { color: palette.ink }]}>{title}</Text>
      <Text style={[styles.stateBody, { color: palette.ink2 }]}>{body}</Text>
      {action !== undefined ? (
        <Pressable accessibilityRole="button" onPress={action.onPress}>
          <GlassPill palette={palette} tone="raised" style={styles.retry}>
            <Text style={[styles.retryText, { color: palette.ink }]}>
              {action.label}
            </Text>
          </GlassPill>
        </Pressable>
      ) : null}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: {
    paddingHorizontal: Space.lg,
    gap: Space.lg,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  backButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { fontSize: 22, lineHeight: 26 },
  statusMeta: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.meta,
  },
  titleBlock: { paddingHorizontal: 4, gap: 6 },
  title: {
    fontFamily: FontFamily.sansSemibold,
    fontSize: FontSize.detailTitle,
    letterSpacing: -0.8,
    lineHeight: FontSize.detailTitle * 1.12,
  },
  subtitle: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.labelSmall,
    lineHeight: FontSize.labelSmall * 1.4,
  },
  message: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.labelSmall,
    paddingHorizontal: 6,
  },
  stateCard: { padding: Space.xl, gap: Space.md },
  stateTitle: {
    fontFamily: FontFamily.sansSemibold,
    fontSize: FontSize.cardTitle,
    letterSpacing: -0.25,
  },
  stateBody: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.labelSmall,
    lineHeight: FontSize.labelSmall * 1.5,
  },
  retry: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: Radius.button,
  },
  retryText: {
    fontFamily: FontFamily.sansSemibold,
    fontSize: FontSize.label,
  },
});
