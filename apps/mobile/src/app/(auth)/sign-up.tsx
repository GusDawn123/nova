import { Link } from 'expo-router';
import { Pressable } from 'react-native';

import { AuthForm } from '@/components/auth-form';
import { ThemedText } from '@/components/themed-text';
import { useAuth } from '@/hooks/use-auth';

/** Dumb screen: renders the shared form and wires it to the auth layer. */
export default function SignUpScreen() {
  const auth = useAuth();

  return (
    <AuthForm
      title="Sign up"
      submitLabel="Create account"
      onSubmit={auth.signUp}
      disabledMessage={auth.status === 'unavailable' ? auth.message : undefined}
      footer={
        <Link href="/sign-in" asChild>
          <Pressable>
            <ThemedText type="linkPrimary">Have an account? Sign in</ThemedText>
          </Pressable>
        </Link>
      }
    />
  );
}
