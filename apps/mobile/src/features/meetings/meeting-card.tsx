import type { ConversationType, MeetingListItem } from '@nova/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { ChamferSurface } from '@/design/chamfer';
import { LightSweep } from '@/design/light-sweep';
import { useCardInTransformOnly } from '@/design/motion';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  type Palette,
} from '@/design/tokens';

import {
  formatDuration,
  formatStartTime,
  statusToPill,
  type StatusPill,
} from './format';

/**
 * One meeting card (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * A soft surface — square-ish corners, no chamfer — because the card is something
 * you READ; the one thing on it that is a control-language shape is the notes chip,
 * and the tap target is the whole card. Today's calls carry an ink wash so the top
 * of the list has weight without a second colour or a second size.
 *
 * STATUS IS SAID, NOT COLOURED. The palette has one ink, so the four coloured pills
 * this card used to wear were four spellings of the same grey. What replaces them:
 *
 *   - notes ready → the one chamfered chip, ink-filled, `NOTES READY`;
 *   - still working → NO chip. A light sweep under the title and a mono whisper in
 *     the meta row. A chip labels something that will stay true; this state exists
 *     precisely because it is about to stop being true;
 *   - failed → plain words in the meta row, and nothing that pretends to be working;
 *   - no notes → silence. A card with nothing to say says nothing (spec §5).
 *
 * Entrance is TRANSFORM-ONLY: the card's text is the content, so an opacity ramp
 * that never completes — a dropped frame, a stubbed clock — would leave a call
 * invisible rather than merely unanimated.
 */

export interface MeetingCardProps {
  meeting: MeetingListItem;
  palette: Palette;
  onPress: (id: string) => void;
  /** Stagger index — the list arrives one card at a time. */
  index?: number;
  /** Today's calls take the ink wash; older ones stay outlined. */
  today?: boolean;
}

/**
 * The meta line's third segment. A `Record` so a fourth conversation type fails to
 * compile here rather than printing a raw wire value at the user.
 */
const TYPE_LABELS: Record<ConversationType, string> = {
  sales: 'Sales',
  interview: 'Interview',
  casual: 'Casual',
};

/** How a status is DRAWN. Deliberately four shapes, and no colour among them. */
type StatusTreatment = 'chip' | 'sweep' | 'words' | 'silent';

/**
 * `statusToPill`'s tone, read as a treatment.
 *
 * The tone names are from the glass era, when they were colours; they survive as the
 * status grouping the list has always had (ready / working / failed / nothing), which
 * is exactly the distinction the duotone now has to draw in shape and words. Switched
 * exhaustively, so a fifth tone is a type error here rather than an undrawn status.
 */
function treatmentFor(tone: StatusPill['tone']): StatusTreatment {
  switch (tone) {
    case 'accent':
      return 'chip';
    case 'shimmer':
      return 'sweep';
    case 'hot':
      return 'words';
    case 'muted':
      return 'silent';
  }
}

export function MeetingCard({
  meeting,
  palette,
  onPress,
  index = 0,
  today = false,
}: MeetingCardProps): React.JSX.Element {
  // Cap the stagger: a 40-meeting list must not take four seconds to appear.
  const entrance = useCardInTransformOnly(Math.min(index, 6) * 60);

  const status = statusToPill(meeting.notes_status);
  const treatment = treatmentFor(status.tone);
  // The words are the whole signal, so they are spelt in the mono register the rest
  // of the machine speech uses. `textTransform` would leave the DOM text mixed-case,
  // which is a difference a screen reader hears.
  const statusWords = status.label.toUpperCase();

  // Only the parts we actually have — a call with no timestamps shows no meta line
  // rather than a row of lonely separators.
  const meta = [
    formatStartTime(meeting.started_at),
    formatDuration(meeting.started_at, meeting.ended_at),
    meeting.conversation_type === null
      ? null
      : TYPE_LABELS[meeting.conversation_type],
  ]
    .filter((part) => part !== null)
    .join(' · ');

  const saysStatus = treatment === 'sweep' || treatment === 'words';

  // The card is ONE button, so its label is everything it says — a `Text` inside a
  // labelled control is not announced, and with status now carried by words alone,
  // a label of just the title would be a card whose status is silent to VoiceOver.
  const spoken = [meeting.title, meta, treatment === 'silent' ? null : statusWords]
    .filter((part) => part !== null && part !== '')
    .join(' · ');

  return (
    <Animated.View style={entrance}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        onPress={() => {
          onPress(meeting.id);
        }}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <View
          testID={`meeting-card-${meeting.id}`}
          style={[
            styles.card,
            { borderColor: palette.inkHairline },
            today && { backgroundColor: palette.inkFill },
          ]}
        >
          <View style={styles.headRow}>
            <Text
              numberOfLines={1}
              style={[styles.title, { color: palette.ink }]}
            >
              {meeting.title}
            </Text>
            {treatment === 'chip' ? (
              <ChamferSurface
                fill={palette.ink}
                style={styles.chip}
                contentStyle={styles.chipContent}
                testID={`meeting-chip-${meeting.id}`}
              >
                <Text style={[styles.chipText, { color: palette.onInk }]}>
                  {statusWords}
                </Text>
              </ChamferSurface>
            ) : null}
          </View>

          {treatment === 'sweep' ? (
            <LightSweep color={palette.ink} style={styles.sweep} />
          ) : null}

          <View testID={`meeting-meta-${meeting.id}`} style={styles.metaRow}>
            {meta === '' ? null : (
              <Text style={[styles.meta, { color: palette.inkSoft }]}>{meta}</Text>
            )}
            {saysStatus && meta !== '' ? (
              <Text style={[styles.meta, { color: palette.inkFaint }]}>·</Text>
            ) : null}
            {saysStatus ? (
              // Secondary ink, NOT the faint placeholder wash: these words are the
              // only carrier of "working" and "failed" now that no colour is, and
              // spec §11 holds secondary text at 75% so it stays legible.
              <Text
                testID={`meeting-status-${meeting.id}`}
                style={[styles.meta, { color: palette.inkSoft }]}
              >
                {statusWords}
              </Text>
            ) : null}
          </View>

          {meeting.tldr === null ? null : (
            <Text
              testID={`meeting-preview-${meeting.id}`}
              numberOfLines={1}
              style={[styles.preview, { color: palette.inkSoft }]}
            >
              {meeting.tldr}
            </Text>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.soft,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Space.lg,
    gap: Space.xs2,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  title: {
    flex: 1,
    fontFamily: FontFamily.bodySemibold,
    fontSize: FontSize.bodySm,
  },
  chip: { alignSelf: 'flex-start' },
  chipContent: {
    paddingHorizontal: Space.sm2,
    paddingVertical: Space.xs,
  },
  chipText: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
  },
  // Under the title, not across the card: the sweep belongs to the thing that is
  // being worked on, which is this call's notes.
  sweep: { marginTop: Space.xs },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Space.xs2,
  },
  meta: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
    letterSpacing: 0.5,
  },
  preview: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
  },
  pressed: { opacity: 0.7 },
});
