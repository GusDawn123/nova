import type { FollowUpStored } from '@nova/shared';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  eyebrowStyle,
  type Palette,
} from '@/design/tokens';
import { StateCard } from '@/features/meetings/state-card';

import { FOLLOW_UP_FAILURE_COPY, type FollowUpFailure } from './follow-up';

/**
 * The Follow-up view (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5): the
 * draft this call produced, or the reason it did not.
 *
 * The failure copy and the retry come from two different places on purpose. WHAT to
 * say is `FOLLOW_UP_FAILURE_COPY`, keyed by kind; WHETHER a retry can help is
 * `FollowUpFailure.canRetry`, which is a claim about the world rather than about
 * wording — a 404 means the meeting is gone, and a button offering to try again on a
 * call that no longer exists is a button that cannot work.
 */

export interface FollowUpPanelProps {
  readonly draft: FollowUpStored | null;
  /** Null when nothing failed — including "there simply is no draft". */
  readonly failure: FollowUpFailure | null;
  readonly onRetry: () => void;
  readonly palette: Palette;
}

export function FollowUpPanel({
  draft,
  failure,
  onRetry,
  palette,
}: FollowUpPanelProps): React.JSX.Element {
  if (draft !== null) {
    return (
      <ScrollView
        testID="follow-up-panel"
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.card, { backgroundColor: palette.inkFill }]}>
          <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
            SUBJECT
          </Text>
          <Text style={[styles.subject, { color: palette.ink }]}>
            {draft.subject}
          </Text>
        </View>
        <View
          style={[
            styles.card,
            {
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: palette.inkHairline,
            },
          ]}
        >
          <Text style={[styles.body, { color: palette.ink }]}>{draft.body}</Text>
        </View>
      </ScrollView>
    );
  }

  if (failure !== null) {
    const copy = FOLLOW_UP_FAILURE_COPY[failure.kind];
    return (
      <StateCard
        palette={palette}
        testID="follow-up-state"
        eyebrow="FOLLOW-UP"
        message={copy.title}
        detail={copy.body}
        action={
          failure.canRetry
            ? { label: 'TRY AGAIN', onPress: onRetry, testID: 'follow-up-retry' }
            : undefined
        }
      />
    );
  }

  return (
    <StateCard
      palette={palette}
      testID="follow-up-empty"
      eyebrow="FOLLOW-UP"
      message="No follow-up was drafted for this call."
      detail="The notes above are the record. Nothing failed — nothing was asked for."
    />
  );
}

const styles = StyleSheet.create({
  scroll: {
    gap: Space.md,
    paddingBottom: Space.xxl,
  },
  card: {
    borderRadius: Radius.soft,
    padding: Space.lg,
    gap: Space.xs2,
  },
  eyebrow: eyebrowStyle,
  subject: {
    fontFamily: FontFamily.bodySemibold,
    fontSize: FontSize.body,
    lineHeight: FontSize.body * 1.4,
  },
  body: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodySm,
    lineHeight: FontSize.bodySm * 1.6,
  },
});
