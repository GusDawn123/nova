import type { Session } from '@supabase/supabase-js';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import {
  APPEARANCE_ORDER,
  useAppearance,
  usePalette,
  type AppearanceChoice,
} from '@/hooks/use-appearance';
import { useAuth } from '@/hooks/use-auth';
import { useDeleteAccount } from '@/hooks/use-delete-account';
import { useHealth } from '@/hooks/use-health';
import { useMe } from '@/hooks/use-me';

/**
 * Account — the quiet screen (spec §8).
 *
 * Everything here is a statement of fact about the account, so it is drawn as a
 * list of soft cards rather than as controls: square corners, an ink-fill wash, and
 * copy that is read once and then left alone. The only three things that ACT —
 * appearance, sign out, delete — are the only three things that are chamfered or
 * spelt out in mono, which is the control language doing its job (spec §3).
 *
 * Destructive weight is carried by words and by SIZE, never by colour: sign out is
 * an outlined key, delete is a mono whisper under it, and the confirm is a second
 * deliberate tap. There is no red in this design (spec §11).
 *
 * A TAB since the last task of the redesign (`◌ ACCOUNT`), which is why it leaves
 * room at the bottom for the floating bar rather than trusting a safe-area inset:
 * the bar is absolutely positioned and reserves nothing.
 *
 * Dumb, as before: every network call still lives in its hook.
 */

/**
 * Picker copy, one label per choice. A `Record` on purpose: a fourth theme added to
 * the union fails to compile here until it has a label, so the row cannot silently
 * offer three of four.
 */
const APPEARANCE_LABELS: Record<AppearanceChoice, string> = {
  cobalt: 'COBALT',
  paper: 'PAPER',
  auto: 'AUTO',
};

/**
 * The plan is NOT on the wire yet: `GET /me` carries `user_id`, `email` and `role`,
 * while the tier lives in `profiles.plan` server-side (Phase 6 metering). The chip
 * says what this screen can actually prove — the account is active — and the name
 * is the product, not a tier claim it cannot back up. Wiring the real tier is a
 * wire change, not a presentation one.
 */
const PLAN_NAME = 'NOVA';

export default function AccountScreen() {
  const auth = useAuth();
  const palette = usePalette();
  const appearance = useAppearance();
  const insets = useSafeAreaInsets();

  // The (app) layout guard guarantees a session by the time this renders;
  // narrow defensively so the screen is self-contained and fully typed.
  if (auth.status !== 'signed-in') {
    return null;
  }
  const { session } = auth;

  return (
    <View
      testID="account-screen"
      style={[styles.screen, { backgroundColor: palette.canvas }]}
    >
      <ScrollView
          testID="account-scroll"
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: insets.top + Space.xl,
              // The floating tab bar is absolutely positioned and reserves no
              // layout space of its own — this is what keeps DELETE ACCOUNT,
              // the last thing on the screen, reachable.
              paddingBottom: tabBarClearance(insets.bottom),
            },
          ]}
        >
          <Text style={[styles.title, { color: palette.ink }]}>ACCOUNT</Text>

          <Card palette={palette}>
            <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
              SIGNED IN AS
            </Text>
            <Text testID="signed-in-email" style={[styles.value, { color: palette.ink }]}>
              {session.user.email ?? 'unknown'}
            </Text>
          </Card>

          <Card palette={palette}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>PLAN</Text>
                <Text style={[styles.value, { color: palette.ink }]}>{PLAN_NAME}</Text>
              </View>
              <ChamferSurface
                fill={palette.ink}
                style={styles.chip}
                contentStyle={styles.chipContent}
              >
                <Text testID="plan-chip" style={[styles.chipText, { color: palette.onInk }]}>
                  ACTIVE
                </Text>
              </ChamferSurface>
            </View>
          </Card>

          <Pressable
            testID="appearance-row"
            accessibilityRole="button"
            accessibilityLabel={`Appearance: ${APPEARANCE_LABELS[appearance.choice]}`}
            accessibilityHint="Switches to the next appearance"
            onPress={appearance.cycle}
            style={({ pressed }) => (pressed ? styles.pressed : undefined)}
          >
            <Card palette={palette}>
              <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>APPEARANCE</Text>
              {/* All three are shown, so the choice reads as a set rather than as a
                  mystery label that changes when tapped. */}
              <View style={styles.choices}>
                {APPEARANCE_ORDER.map((choice) => (
                  <Text
                    key={choice}
                    testID={`appearance-${choice}`}
                    style={[
                      styles.choice,
                      {
                        color:
                          choice === appearance.choice ? palette.ink : palette.inkFaint,
                      },
                    ]}
                  >
                    {APPEARANCE_LABELS[choice]}
                  </Text>
                ))}
              </View>
            </Card>
          </Pressable>

          <Card palette={palette}>
            <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>CONNECTION</Text>
            <HealthStatus palette={palette} />
            <MeProof session={session} palette={palette} />
          </Card>

          <Pressable
            testID="sign-out-button"
            accessibilityRole="button"
            onPress={() => void auth.signOut()}
            style={({ pressed }) => (pressed ? styles.pressed : undefined)}
          >
            <ChamferSurface
              cut={Chamfer.key}
              stroke={palette.ink}
              style={styles.key}
              contentStyle={styles.keyContent}
            >
              <Text style={[styles.keyLabel, { color: palette.ink }]}>SIGN OUT</Text>
            </ChamferSurface>
          </Pressable>

          <DeleteAccount session={session} palette={palette} />
      </ScrollView>
    </View>
  );
}

/** One soft card: square corners, ink wash, nothing to press. */
function Card({
  palette,
  children,
}: {
  palette: Palette;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.card, { backgroundColor: palette.inkFill }]}>{children}</View>
  );
}

function HealthStatus({ palette }: { palette: Palette }): React.JSX.Element {
  const health = useHealth();

  switch (health.status) {
    case 'loading':
      return (
        <Text style={[styles.whisper, { color: palette.inkFaint }]}>
          checking server…
        </Text>
      );
    case 'success':
      return (
        <Text style={[styles.whisper, { color: palette.inkSoft }]}>
          {`server ${health.data.ok ? 'ok' : 'not ok'} · v${health.data.version}`}
        </Text>
      );
    case 'error':
      return (
        <Text style={[styles.whisper, { color: palette.inkSoft }]}>
          {`server unreachable · ${health.message}`}
        </Text>
      );
  }
}

/** Signed-in proof: hits the protected `GET /me` with the access token. */
function MeProof({
  session,
  palette,
}: {
  session: Session;
  palette: Palette;
}): React.JSX.Element {
  const me = useMe(session.access_token);

  switch (me.status) {
    case 'loading':
      return (
        <Text style={[styles.whisper, { color: palette.inkFaint }]}>
          verifying identity…
        </Text>
      );
    case 'success':
      return (
        <Text testID="me-user-id" style={[styles.whisper, { color: palette.inkSoft }]}>
          {`identity ${me.data.user_id}`}
        </Text>
      );
    case 'error':
      return (
        <Text style={[styles.whisper, { color: palette.inkSoft }]}>
          {`/me failed · ${me.message}`}
        </Text>
      );
  }
}

/**
 * Delete-account action with a two-step confirm. RN `Alert` has no web support,
 * so instead of a native dialog we reveal an inline confirm/cancel pair on the
 * first press (works on web and native). The confirm toggle is trivial view
 * state; the network + sign-out logic lives in `useDeleteAccount` (screens dumb).
 */
function DeleteAccount({
  session,
  palette,
}: {
  session: Session;
  palette: Palette;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const { state, deleteAccount } = useDeleteAccount(session.access_token);
  const busy = state.status === 'deleting';

  if (!confirming) {
    return (
      <Pressable
        testID="delete-account-button"
        accessibilityRole="button"
        onPress={() => {
          setConfirming(true);
        }}
        style={({ pressed }) => [styles.whisperRow, pressed && styles.pressed]}
      >
        <Text style={[styles.whisperKey, { color: palette.inkFaint }]}>
          DELETE ACCOUNT
        </Text>
      </Pressable>
    );
  }

  return (
    <Card palette={palette}>
      <Text style={[styles.body, { color: palette.inkSoft }]}>
        This permanently deletes your account and all data.
      </Text>
      {state.status === 'error' && (
        <Text
          testID="delete-account-error"
          style={[styles.body, { color: palette.inkSoft }]}
        >
          {`Delete failed: ${state.message}`}
        </Text>
      )}
      <Pressable
        testID="delete-account-confirm"
        accessibilityRole="button"
        disabled={busy}
        aria-disabled={busy}
        onPress={() => void deleteAccount()}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <ChamferSurface
          fill={palette.ink}
          style={styles.key}
          contentStyle={styles.keyContent}
        >
          <Text style={[styles.keyLabel, { color: palette.onInk }]}>
            {busy ? 'DELETING…' : 'CONFIRM DELETE'}
          </Text>
        </ChamferSurface>
      </Pressable>
      <Pressable
        testID="delete-account-cancel"
        accessibilityRole="button"
        disabled={busy}
        onPress={() => {
          setConfirming(false);
        }}
        style={({ pressed }) => [styles.whisperRow, pressed && styles.pressed]}
      >
        <Text style={[styles.whisperKey, { color: palette.inkFaint }]}>KEEP ACCOUNT</Text>
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    paddingHorizontal: Space.xl,
    gap: Space.md,
  },
  title: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displayMd,
    letterSpacing: 4,
    marginBottom: Space.sm,
  },
  card: {
    borderRadius: Radius.soft,
    padding: Space.lg,
    gap: Space.xs2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowText: { gap: Space.xs2 },
  eyebrow: eyebrowStyle,
  value: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.body,
  },
  body: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.4,
  },
  choices: {
    flexDirection: 'row',
    gap: Space.lg,
    marginTop: Space.xs,
  },
  choice: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoSm,
    letterSpacing: 2,
  },
  chip: { alignSelf: 'center' },
  chipContent: {
    paddingHorizontal: Space.md,
    paddingVertical: Space.xs2,
  },
  chipText: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 2,
  },
  whisper: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
  },
  whisperRow: {
    minHeight: Size.tapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  whisperKey: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    letterSpacing: 2,
  },
  key: {
    minHeight: Size.tapTarget,
    justifyContent: 'center',
    marginTop: Space.sm,
  },
  keyContent: {
    paddingVertical: Space.lg,
    alignItems: 'center',
  },
  keyLabel: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displaySm,
    letterSpacing: 2,
  },
  pressed: { opacity: 0.7 },
});
