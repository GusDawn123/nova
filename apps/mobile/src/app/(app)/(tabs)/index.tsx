import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChamferSurface } from '@/design/chamfer';
import { tabBarClearance } from '@/design/tab-bar-metrics';
import {
  Chamfer,
  FontFamily,
  FontSize,
  Radius,
  Size,
  Space,
  eyebrowStyle,
  type Palette,
} from '@/design/tokens';
import { MascotStage } from '@/features/mascot/mascot-stage';
import { type RecencyGroup, groupMeetingsByRecency } from '@/features/meetings/format';
import { LoadingList } from '@/features/meetings/loading-list';
import { MeetingCard } from '@/features/meetings/meeting-card';
import { usePalette } from '@/hooks/use-appearance';
import { useMeetings } from '@/hooks/use-meetings';

/**
 * Meetings — the archive (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * The app's home screen, and the one that has to look right at every size of
 * history: none, three, four hundred. So it is a plain column — wordmark, the
 * month's count, recency eyebrows, soft cards — with no chrome that a long list
 * would have to fight.
 *
 * Dumb: `useMeetings` owns the fetch and its four states, and everything drawn is
 * derived by the pure helpers in `features/meetings/format.ts` (RULES §10).
 *
 * Each of the four states is DRAWN, not skipped: three skeleton cards while the list
 * loads, the mascot moment when there is nothing yet, a soft card with a chamfered
 * RETRY when the fetch fails, and — deliberately without a retry — a copy card when
 * there is no session (nothing this screen can re-run mints one).
 */
export default function MeetingsScreen(): React.JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { state, refresh, refreshing } = useMeetings();

  // The section headings are a function of the current LOCAL day, so an app left
  // foregrounded across midnight would keep calling yesterday "today". Re-read the
  // clock whenever the screen is focused rather than running a timer for it.
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, []),
  );

  const sections = useMemo(() => {
    if (state.status !== 'success') return [];
    return groupMeetingsByRecency(state.data.meetings, now);
  }, [state, now]);

  return (
    <View style={[styles.root, { backgroundColor: palette.canvas }]}>
      <ScrollView
        testID="meetings-scroll"
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + Space.xl,
            // The floating tab bar is absolutely positioned and reserves no layout
            // space of its own — this is what keeps the last card reachable.
            paddingBottom: tabBarClearance(insets.bottom),
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={palette.inkFaint}
          />
        }
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: palette.ink }]}>MEETINGS</Text>
          {state.status === 'success' ? (
            <Text style={[styles.monthCount, { color: palette.inkSoft }]}>
              {monthCountLabel(state.data.month_count)}
            </Text>
          ) : null}
        </View>

        {state.status === 'loading' ? <LoadingList palette={palette} /> : null}

        {state.status === 'signed-out' ? (
          <SignedOutCard palette={palette} />
        ) : null}

        {state.status === 'error' ? (
          <ErrorCard
            palette={palette}
            message={state.message}
            onRetry={refresh}
          />
        ) : null}

        {state.status === 'success' && sections.length === 0 ? (
          <EmptyState
            palette={palette}
            onStart={() => {
              router.push('/live');
            }}
          />
        ) : null}

        {sections.map((section) => (
          <View key={section.group} style={styles.section}>
            <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
              {GROUP_LABELS[section.group]}
            </Text>
            {section.meetings.map((meeting, i) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                palette={palette}
                index={i}
                today={section.group === 'today'}
                onPress={(id) => {
                  router.push(`/meetings/${id}`);
                }}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * The section headings. A `Record`, so a fourth recency group fails to compile here
 * rather than rendering a raw bucket name; the dashes are the mock's, and
 * `eyebrowStyle` uppercases them on screen without shouting at a screen reader.
 */
const GROUP_LABELS: Record<RecencyGroup, string> = {
  today: '— Today —',
  'this week': '— This week —',
  earlier: '— Earlier —',
};

/** "18 this month" — singular-safe, and never "0 this month". */
function monthCountLabel(count: number): string {
  if (count === 0) return 'No calls yet this month';
  return `${String(count)} this month`;
}

/**
 * First run. She is the whole screen here, because there is nothing else true to
 * put on it — and an empty list with no explanation reads as broken rather than new.
 */
function EmptyState({
  palette,
  onStart,
}: {
  palette: Palette;
  onStart: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <MascotStage size={220} color={palette.ink} />
      <Text style={[styles.emptyTitle, { color: palette.ink }]}>
        NO CALLS YET
      </Text>
      <Text style={[styles.emptyBody, { color: palette.inkSoft }]}>
        {"Your first call becomes your first memory. I'll keep the notes."}
      </Text>
      <Pressable
        testID="start-session-key"
        accessibilityRole="button"
        onPress={onStart}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <ChamferSurface
          cut={Chamfer.key}
          fill={palette.ink}
          style={styles.key}
          contentStyle={styles.keyContent}
        >
          <Text style={[styles.keyLabel, { color: palette.onInk }]}>
            ◉ START A SESSION
          </Text>
        </ChamferSurface>
      </Pressable>
    </View>
  );
}

/**
 * No session. Deliberately WITHOUT a retry: nothing this screen can re-run produces
 * a session, and `(app)/_layout.tsx` already redirects a signed-out user to
 * `/sign-in` — so this is the brief window before that lands, not a dead end the
 * user has to navigate out of themselves.
 */
function SignedOutCard({ palette }: { palette: Palette }): React.JSX.Element {
  return (
    <View
      testID="signed-out-card"
      style={[styles.stateCard, { backgroundColor: palette.inkFill }]}
    >
      <Text style={[styles.stateTitle, { color: palette.ink }]}>
        SIGNED OUT
      </Text>
      <Text style={[styles.stateBody, { color: palette.inkSoft }]}>
        Sign in to see your calls and the notes Nova wrote for them.
      </Text>
    </View>
  );
}

/** A failure, in the server's own words, with the one thing that can help it. */
function ErrorCard({
  palette,
  message,
  onRetry,
}: {
  palette: Palette;
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <View
      testID="error-card"
      style={[styles.stateCard, { backgroundColor: palette.inkFill }]}
    >
      <Text style={[styles.stateTitle, { color: palette.ink }]}>
        COULD NOT LOAD YOUR CALLS
      </Text>
      <Text style={[styles.stateBody, { color: palette.inkSoft }]}>
        {message}
      </Text>
      <Pressable
        testID="retry-button"
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <ChamferSurface
          stroke={palette.ink}
          style={styles.retry}
          contentStyle={styles.retryContent}
        >
          <Text style={[styles.retryLabel, { color: palette.ink }]}>RETRY</Text>
        </ChamferSurface>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: {
    paddingHorizontal: Space.xl,
    gap: Space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displayMd,
    letterSpacing: 4,
  },
  monthCount: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
  },
  section: { gap: Space.md },
  eyebrow: {
    ...eyebrowStyle,
    textAlign: 'center',
    paddingTop: Space.xs,
  },
  empty: {
    alignItems: 'center',
    gap: Space.md,
    paddingTop: Space.xl,
  },
  emptyTitle: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displayMd,
    letterSpacing: 3,
  },
  emptyBody: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.5,
    textAlign: 'center',
    paddingHorizontal: Space.xxl,
  },
  key: {
    minHeight: Size.tapTarget,
    justifyContent: 'center',
    marginTop: Space.md,
  },
  keyContent: {
    paddingVertical: Space.lg,
    paddingHorizontal: Space.xxl,
    alignItems: 'center',
  },
  keyLabel: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displaySm,
    letterSpacing: 2,
  },
  stateCard: {
    borderRadius: Radius.soft,
    padding: Space.xl,
    gap: Space.md,
  },
  stateTitle: {
    fontFamily: FontFamily.displayMid,
    fontSize: FontSize.displaySm,
    letterSpacing: 2,
  },
  stateBody: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.5,
  },
  retry: { alignSelf: 'flex-start' },
  retryContent: {
    minHeight: Size.tapTarget,
    paddingHorizontal: Space.xl,
    justifyContent: 'center',
  },
  retryLabel: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoSm,
    letterSpacing: 2,
  },
  pressed: { opacity: 0.7 },
});
