import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { AuthForm } from '@/components/auth-form';
import { FontFamily, FontSize } from '@/design/tokens';
import { usePalette } from '@/hooks/use-appearance';
import { useAuth } from '@/hooks/use-auth';

/** Dumb screen: renders the shared form and wires it to the auth layer. */
export default function SignUpScreen() {
  const auth = useAuth();
  const palette = usePalette();

  return (
    <AuthForm
      submitLabel="CREATE ACCOUNT"
      confirmPassword
      onSubmit={auth.signUp}
      disabledMessage={auth.status === 'unavailable' ? auth.message : undefined}
      footer={
        <Link href="/sign-in" asChild>
          <Pressable accessibilityRole="link">
            <Text style={[styles.link, { color: palette.inkSoft }]}>
              HAVE AN ACCOUNT? SIGN IN
            </Text>
          </Pressable>
        </Link>
      }
    />
  );
}

const styles = StyleSheet.create({
  // A mono whisper, per spec §8 — the way out, not a second call to action.
  link: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    letterSpacing: 1.5,
  },
});
