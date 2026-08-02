import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassPill, GlassSurface } from '@/design/glass';
import { tabBarClearance } from '@/design/tab-bar-metrics';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  eyebrowStyle,
  paletteFor,
  type Palette,
} from '@/design/tokens';
import { groupMeetingsByRecency } from '@/features/meetings/format';
import { MeetingCard } from '@/features/meetings/meeting-card';
import { useMeetings } from '@/hooks/use-meetings';

/**
 * The Meetings list — the app's home screen (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §7.2).
 *
 * Dumb: `useMeetings` owns the fetch and its state, and everything rendered is
 * derived by the pure helpers in `features/meetings/format.ts` (RULES §10).
 *
 * Account lives behind the button in this header rather than in the tab bar, which
 * keeps the bar at the two pills the mock draws (Gustavo, 2026-07-28).
 */
export default function MeetingsScreen(): React.JSX.Element {
  const scheme = useColorScheme();
  const palette = paletteFor(scheme);
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
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + Space.md,
            paddingBottom: tabBarClearance(insets.bottom),
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={palette.ink3}
          />
        }
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.screenTitle, { color: palette.ink }]}>
              Meetings
            </Text>
            {state.status === 'success' ? (
              <Text style={[styles.monthCount, { color: palette.ink3 }]}>
                {monthCountLabel(state.data.month_count)}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Account"
            onPress={() => {
              router.push('/account');
            }}
          >
            <GlassPill
              palette={palette}
              style={styles.avatar}
              testID="account-button"
            >
              <Text style={[styles.avatarGlyph, { color: palette.ink2 }]}>
                {'⚙'}
              </Text>
            </GlassPill>
          </Pressable>
        </View>

        {state.status === 'loading' ? (
          <Text style={[styles.message, { color: palette.ink3 }]}>
            Loading your calls…
          </Text>
        ) : null}

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
          <EmptyState palette={palette} />
        ) : null}

        {sections.map((section, sectionIndex) => (
          <View key={section.group} style={styles.section}>
            <Text style={[styles.eyebrow, { color: palette.ink3 }]}>
              {section.group}
            </Text>
            {section.meetings.map((meeting, i) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                palette={palette}
                index={i}
                // The mock raises only the newest call.
                featured={sectionIndex === 0 && i === 0}
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

/** "18 this month" — singular-safe, and never "0 this month". */
function monthCountLabel(count: number): string {
  if (count === 0) return 'No calls yet this month';
  return `${String(count)} this month`;
}

/**
 * First-run state. Says what Nova does and where calls come from: an empty list
 * with no explanation reads as broken rather than new.
 */
function EmptyState({ palette }: { palette: Palette }): React.JSX.Element {
  return (
    <GlassSurface palette={palette} style={styles.stateCard} elevated>
      <Text style={[styles.stateTitle, { color: palette.ink }]}>
        No calls yet
      </Text>
      <Text style={[styles.stateBody, { color: palette.ink2 }]}>
        Nova listens on speakerphone, suggests what to say while you talk, and
        writes the notes afterwards. Your finished calls show up here.
      </Text>
    </GlassSurface>
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
    <GlassSurface palette={palette} style={styles.stateCard} elevated>
      <Text style={[styles.stateTitle, { color: palette.ink }]}>
        You are signed out
      </Text>
      <Text style={[styles.stateBody, { color: palette.ink2 }]}>
        Sign in to see your calls and the notes Nova wrote for them.
      </Text>
    </GlassSurface>
  );
}

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
    <GlassSurface palette={palette} style={styles.stateCard} elevated>
      <Text style={[styles.stateTitle, { color: palette.ink }]}>
        Could not load your meetings
      </Text>
      <Text style={[styles.stateBody, { color: palette.ink2 }]}>{message}</Text>
      <Pressable accessibilityRole="button" onPress={onRetry}>
        <GlassPill palette={palette} tone="raised" style={styles.retry}>
          <Text style={[styles.retryText, { color: palette.ink }]}>
            Try again
          </Text>
        </GlassPill>
      </Pressable>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: {
    paddingHorizontal: Space.lg,
    gap: Space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
  },
  headerText: { gap: 2 },
  screenTitle: {
    fontFamily: FontFamily.sansSemibold,
    fontSize: FontSize.screenTitle,
    letterSpacing: -0.9,
  },
  monthCount: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.metaSmall,
  },
  avatar: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarGlyph: { fontSize: 16 },
  section: { gap: Space.md },
  eyebrow: {
    ...eyebrowStyle,
    paddingHorizontal: 6,
    paddingTop: Space.xs,
  },
  message: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.labelSmall,
    paddingHorizontal: 6,
  },
  stateCard: {
    padding: Space.xl,
    gap: Space.md,
  },
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
