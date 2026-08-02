import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { AuthForm } from '@/components/auth-form';
import { FontFamily, FontSize, Size } from '@/design/tokens';
import { usePalette } from '@/hooks/use-appearance';
import { useAuth } from '@/hooks/use-auth';

/** Dumb screen: renders the shared form and wires it to the auth layer. */
export default function SignInScreen() {
  const auth = useAuth();
  const palette = usePalette();

  return (
    <AuthForm
      submitLabel="SIGN IN"
      onSubmit={auth.signIn}
      disabledMessage={auth.status === 'unavailable' ? auth.message : undefined}
      footer={
        <Link href="/sign-up" asChild>
          <Pressable accessibilityRole="link" style={styles.footerPress}>
            <Text style={[styles.link, { color: palette.inkSoft }]}>
              NEED AN ACCOUNT? SIGN UP
            </Text>
          </Pressable>
        </Link>
      }
    />
  );
}

const styles = StyleSheet.create({
  // The whisper is small; its TARGET is not. A real 44pt box rather than `hitSlop` —
  // react-native-web ignores hitSlop, and Expo Web is this project's verification
  // target — and this is the only way from the front door to an account.
  footerPress: {
    minHeight: Size.tapTarget,
    justifyContent: 'center',
  },
  // A mono whisper, per spec §8 — the way out, not a second call to action.
  link: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    letterSpacing: 1.5,
  },
});
