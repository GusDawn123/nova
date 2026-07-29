import type { Session } from '@supabase/supabase-js';
import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useDeleteAccount } from '@/hooks/use-delete-account';
import { useHealth } from '@/hooks/use-health';
import { useMe } from '@/hooks/use-me';

function HealthStatus() {
  const health = useHealth();

  switch (health.status) {
    case 'loading':
      return (
        <ThemedText type="default" themeColor="textSecondary">
          checking server…
        </ThemedText>
      );
    case 'success':
      return (
        <ThemedText type="default">
          Server: {health.data.ok ? 'ok' : 'not ok'} · v{health.data.version}
        </ThemedText>
      );
    case 'error':
      return (
        <ThemedView type="backgroundElement" style={styles.statusCard}>
          <ThemedText type="default">server unreachable</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {health.message}
          </ThemedText>
        </ThemedView>
      );
  }
}

/** Signed-in proof: hits the protected `GET /me` with the access token. */
function MeProof({ session }: { session: Session }) {
  const me = useMe(session.access_token);

  switch (me.status) {
    case 'loading':
      return (
        <ThemedText type="small" themeColor="textSecondary">
          verifying identity…
        </ThemedText>
      );
    case 'success':
      return (
        <ThemedView type="backgroundElement" style={styles.statusCard}>
          <ThemedText type="small" themeColor="textSecondary">
            /me verified
          </ThemedText>
          <ThemedText testID="me-user-id" type="small">
            user_id: {me.data.user_id}
          </ThemedText>
        </ThemedView>
      );
    case 'error':
      return (
        <ThemedView type="backgroundElement" style={styles.statusCard}>
          <ThemedText type="small">/me failed</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {me.message}
          </ThemedText>
        </ThemedView>
      );
  }
}

/**
 * Delete-account action with a two-step confirm. RN `Alert` has no web support,
 * so instead of a native dialog we reveal an inline confirm/cancel pair on the
 * first press (works on web and native). The confirm toggle is trivial view
 * state; the network + sign-out logic lives in `useDeleteAccount` (screens dumb).
 */
function DeleteAccount({ session }: { session: Session }) {
  const [confirming, setConfirming] = useState(false);
  const { state, deleteAccount } = useDeleteAccount(session.access_token);
  const busy = state.status === 'deleting';

  if (!confirming) {
    return (
      <Pressable
        testID="delete-account-button"
        accessibilityRole="button"
        onPress={() => setConfirming(true)}
        style={({ pressed }) => pressed && styles.pressed}>
        <ThemedView type="backgroundElement" style={styles.signOut}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Delete account
          </ThemedText>
        </ThemedView>
      </Pressable>
    );
  }

  return (
    <ThemedView type="backgroundElement" style={styles.statusCard}>
      <ThemedText type="small" themeColor="textSecondary">
        This permanently deletes your account and all data.
      </ThemedText>
      {state.status === 'error' && (
        <ThemedText testID="delete-account-error" type="small">
          Delete failed: {state.message}
        </ThemedText>
      )}
      <Pressable
        testID="delete-account-confirm"
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void deleteAccount()}
        style={({ pressed }) => pressed && styles.pressed}>
        <ThemedView type="backgroundSelected" style={styles.signOut}>
          <ThemedText type="smallBold">
            {busy ? 'Deleting…' : 'Confirm delete'}
          </ThemedText>
        </ThemedView>
      </Pressable>
      <Pressable
        testID="delete-account-cancel"
        accessibilityRole="button"
        disabled={busy}
        onPress={() => setConfirming(false)}
        style={({ pressed }) => pressed && styles.pressed}>
        <ThemedText type="smallBold" themeColor="textSecondary">
          Cancel
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

export default function AccountScreen() {
  const auth = useAuth();

  // The (app) layout guard guarantees a session by the time this renders;
  // narrow defensively so the screen is self-contained and fully typed.
  if (auth.status !== 'signed-in') {
    return null;
  }
  const { session } = auth;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="title" style={styles.title}>
          Nova
        </ThemedText>

        <ThemedText testID="signed-in-email" type="default">
          Signed in as {session.user.email ?? 'unknown'}
        </ThemedText>

        <HealthStatus />
        <MeProof session={session} />

        <Pressable
          testID="sign-out-button"
          accessibilityRole="button"
          onPress={() => void auth.signOut()}
          style={({ pressed }) => pressed && styles.pressed}>
          <ThemedView type="backgroundSelected" style={styles.signOut}>
            <ThemedText type="smallBold">Sign out</ThemedText>
          </ThemedView>
        </Pressable>

        <DeleteAccount session={session} />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    flexDirection: 'row',
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    maxWidth: MaxContentWidth,
  },
  title: {
    textAlign: 'center',
  },
  statusCard: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
  },
  signOut: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
  },
  pressed: {
    opacity: 0.7,
  },
});
