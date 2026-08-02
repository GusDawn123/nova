import type { MeetingNotes, NotesStatus } from '@nova/shared';
import { StyleSheet, Text, View } from 'react-native';

import { FontFamily, FontSize, Space, type Palette } from '@/design/tokens';
import { StateCard } from '@/features/meetings/state-card';

import { NotesPanel } from './notes-panel';

/**
 * The Notes tab: the notes when there are notes, and one honest card when there are
 * not (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * The five branches are ordered by what the user most needs to know, not by the
 * shape of the state machine. A read that failed outranks everything, because
 * nothing below it is known. Notes that EXIST outrank the status that produced them
 * — a still-`processing` call whose live preview has landed shows the preview, since
 * a "please wait" over notes the user can already read is a lie about what is on
 * screen.
 *
 * `processing` and `queued` say the same sentence: one of them is a job that has not
 * started yet, and that distinction belongs to the queue, not to a person waiting.
 *
 * Every one of these cards points at the transcript, and that is deliberate. The
 * transcript is what actually happened; notes are what was made of it. A pipeline
 * failure must not read as a call that was lost.
 */

export interface NotesViewProps {
  palette: Palette;
  /** Post-call notes, or the live preview — the read model already picked. */
  notes: MeetingNotes | null;
  /** True when `notes` is the running preview rather than the finished write-up. */
  isPreview: boolean;
  status: NotesStatus | null;
  /** The read's own failure, which outranks every notes state below it. */
  errorMessage: string | null;
  loading: boolean;
  completedIds: ReadonlySet<string>;
  onToggleItem: (itemId: string, completed: boolean) => void;
  onRetry: () => void;
}

export function NotesView({
  palette,
  notes,
  isPreview,
  status,
  errorMessage,
  loading,
  completedIds,
  onToggleItem,
  onRetry,
}: NotesViewProps): React.JSX.Element {
  if (errorMessage !== null) {
    return (
      <StateCard
        palette={palette}
        testID="notes-error"
        eyebrow="NOTES"
        message="These notes wouldn't load"
        detail={errorMessage}
        action={{ label: 'TRY AGAIN', onPress: onRetry, testID: 'notes-retry' }}
      />
    );
  }

  if (loading) {
    return (
      <StateCard
        palette={palette}
        testID="notes-loading"
        eyebrow="NOTES"
        message="Opening the call."
        waiting
      />
    );
  }

  if (notes !== null) {
    return (
      <View style={styles.stack}>
        {/* Say plainly when this is the running preview rather than the finished
            notes — the two look identical otherwise, and the user should know
            which one they are reading. */}
        {isPreview ? (
          <Text
            testID="notes-preview-note"
            style={[styles.previewNote, { color: palette.inkFaint }]}
          >
            STILL BEING WRITTEN — THIS FILLS IN AS THE CALL IS PROCESSED
          </Text>
        ) : null}
        <NotesPanel
          notes={notes}
          palette={palette}
          completedIds={completedIds}
          onToggleItem={onToggleItem}
        />
      </View>
    );
  }

  if (status === 'processing' || status === 'queued') {
    return (
      <StateCard
        palette={palette}
        testID="notes-processing"
        eyebrow="NOTES"
        message="She's re-reading the call. A minute, maybe two."
        detail="The transcript is already here — the tab above is open."
        waiting
      />
    );
  }

  if (status === 'failed') {
    return (
      <StateCard
        palette={palette}
        testID="notes-failed"
        eyebrow="NOTES"
        message="The notes didn't make it through"
        detail="The call itself is safe: the transcript tab above still has every word of it."
        // TRY AGAIN re-READS the meeting — the only path this screen has.
        // `POST /meetings/:id/notes/regenerate` exists server-side and nothing on
        // the phone calls it yet, so the word is "again", not "rewrite".
        action={{ label: 'TRY AGAIN', onPress: onRetry, testID: 'notes-retry' }}
      />
    );
  }

  return (
    <StateCard
      palette={palette}
      testID="notes-empty"
      eyebrow="NOTES"
      message="No notes for this call."
      detail="Calls from before Nova wrote notes still keep their transcript."
    />
  );
}

const styles = StyleSheet.create({
  stack: { flex: 1, gap: Space.md },
  previewNote: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
    letterSpacing: 1,
  },
});
