import type { MeetingListItem } from '@nova/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { GlassPill, GlassSurface } from '@/design/glass';
import { useCardInTransformOnly, useShimmer } from '@/design/motion';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  type Palette,
} from '@/design/tokens';

import {
  cardChips,
  formatDuration,
  formatStartTime,
  formatWeekday,
  statusToPill,
} from './format';

/**
 * One meeting card (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.4).
 *
 * Entrance uses {@link useCardInTransformOnly}, NOT `useCardIn`: the card wraps a
 * `GlassView`, and an opacity ramp from 0 would stop the glass rendering entirely
 * (see `design/motion.ts`). Slides and scales in instead.
 */

export interface MeetingCardProps {
  meeting: MeetingListItem;
  palette: Palette;
  onPress: (id: string) => void;
  /** Stagger index — the mock brings the list in one card at a time. */
  index?: number;
  /** The mock gives the newest card a raised, larger treatment. */
  featured?: boolean;
}

export function MeetingCard({
  meeting,
  palette,
  onPress,
  index = 0,
  featured = false,
}: MeetingCardProps): React.JSX.Element {
  // Cap the stagger: a 40-meeting list must not take four seconds to appear.
  const entrance = useCardInTransformOnly(Math.min(index, 6) * 60);
  const pill = statusToPill(meeting.notes_status);
  const chips = cardChips(meeting);

  const duration = formatDuration(meeting.started_at, meeting.ended_at);
  const time = formatStartTime(meeting.started_at);
  const weekday = formatWeekday(meeting.started_at);
  // Only the parts we actually have — a call with no timestamps shows no subtitle
  // rather than a lonely separator.
  const subtitle = [weekday, duration, time].filter((p) => p !== null).join(' · ');

  return (
    <Animated.View style={entrance}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={meeting.title}
        onPress={() => {
          onPress(meeting.id);
        }}
      >
        <GlassSurface
          palette={palette}
          tone={featured ? 'raised' : 'regular'}
          radius={featured ? Radius.card : Radius.cardSmall}
          elevated={featured}
          style={styles.card}
          testID={`meeting-card-${meeting.id}`}
        >
          <View style={styles.headRow}>
            <View style={styles.headText}>
              <Text
                numberOfLines={1}
                style={[
                  styles.title,
                  {
                    color: palette.ink,
                    fontSize: featured ? FontSize.cardTitle : FontSize.tldr,
                  },
                ]}
              >
                {meeting.title}
              </Text>
              {subtitle.length > 0 ? (
                <Text style={[styles.subtitle, { color: palette.ink3 }]}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <StatusPill palette={palette} pill={pill} />
          </View>

          {meeting.tldr !== null ? (
            <Text
              numberOfLines={3}
              style={[styles.tldr, { color: palette.ink2 }]}
            >
              {meeting.tldr}
            </Text>
          ) : null}

          {chips.length > 0 ? (
            <View style={styles.chipRow}>
              {chips.map((chip) => (
                <View
                  key={chip}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: palette.glass,
                      borderColor: palette.stroke,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: palette.ink2 }]}>
                    {chip}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

/** The status pill. `shimmer` sweeps; the rest are static. */
function StatusPill({
  palette,
  pill,
}: {
  palette: Palette;
  pill: ReturnType<typeof statusToPill>;
}): React.JSX.Element {
  const sweeping = pill.tone === 'shimmer';
  // Gated, not skipped: the hook must be called unconditionally, but a static pill
  // must not leave an infinite `withRepeat` running behind a style nobody reads —
  // a 40-row list is 40 of them.
  const shimmer = useShimmer(120, sweeping);

  const dotColor =
    pill.tone === 'accent'
      ? palette.ink
      : pill.tone === 'hot'
        ? palette.hot
        : palette.ink3;

  return (
    <GlassPill
      palette={palette}
      style={[
        styles.statusPill,
        pill.tone === 'accent' && {
          backgroundColor: palette.inkFill,
          borderColor: palette.inkHairline,
        },
      ]}
      testID={`status-${pill.tone}`}
    >
      {sweeping ? (
        <Animated.View
          style={[
            styles.shimmerBand,
            { backgroundColor: palette.sheen },
            shimmer,
          ]}
        />
      ) : (
        <View
          style={[styles.statusDot, { backgroundColor: dotColor }]}
        />
      )}
      <Text style={[styles.statusText, { color: palette.ink2 }]}>
        {pill.label}
      </Text>
    </GlassPill>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Space.xl,
    gap: Space.md,
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  headText: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontFamily: FontFamily.sansSemibold,
    letterSpacing: -0.25,
  },
  subtitle: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.metaSmall,
  },
  tldr: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.labelSmall,
    lineHeight: FontSize.labelSmall * 1.45,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
  },
  chip: {
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.captionSmall,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  statusText: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.captionSmall,
  },
  shimmerBand: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 40,
    opacity: 0.35,
  },
});
