import { Link } from 'expo-router';
import { Pressable } from 'react-native';

import { AuthForm } from '@/components/auth-form';
import { ThemedText } from '@/components/themed-text';
import { useAuth } from '@/hooks/use-auth';

/** Dumb screen: renders the shared form and wires it to the auth layer. */
export default function SignInScreen() {
  const auth = useAuth();

  return (
    <AuthForm
      title="Sign in"
      submitLabel="Sign in"
      onSubmit={auth.signIn}
      disabledMessage={auth.status === 'unavailable' ? auth.message : undefined}
      footer={
        <Link href="/sign-up" asChild>
          <Pressable>
            <ThemedText type="linkPrimary">Need an account? Sign up</ThemedText>
          </Pressable>
        </Link>
      }
    />
  );
}
