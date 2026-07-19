import { Redirect, Stack } from 'expo-router';

import { useAuth } from '@/hooks/use-auth';

/**
 * Guard for the auth screens: a signed-in user has no business here, so bounce
 * them to the app. `loading` and `unavailable` both fall through to the form
 * (the form itself explains the `unavailable` case).
 */
export default function AuthLayout() {
  const auth = useAuth();

  if (auth.status === 'signed-in') {
    return <Redirect href="/" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
