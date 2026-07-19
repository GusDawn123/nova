import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { AuthActionResult } from '@/hooks/use-auth';

/**
 * Dumb, reusable email/password form. Owns only its own field/submit/error UI
 * state; the actual auth call is injected via `onSubmit` (which returns a typed
 * result), keeping the sign-in / sign-up screens thin. Tokens-only styling.
 */
export interface AuthFormProps {
  title: string;
  submitLabel: string;
  onSubmit: (email: string, password: string) => Promise<AuthActionResult>;
  /** Footer slot — typically the link to the other auth screen. */
  footer: ReactNode;
  /** When set, the form is inert and shows this message (e.g. auth unavailable). */
  disabledMessage?: string;
}

export function AuthForm({ title, submitLabel, onSubmit, footer, disabledMessage }: AuthFormProps) {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const disabled = disabledMessage !== undefined;

  async function handleSubmit(): Promise<void> {
    setError(null);
    setSubmitting(true);
    const result = await onSubmit(email.trim(), password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
    }
    // On success the auth-state change drives navigation (the (auth) layout
    // redirects a signed-in user away), so there is nothing to do here.
  }

  const inputStyle = [
    styles.input,
    { backgroundColor: theme.backgroundElement, color: theme.text },
  ];

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.form}>
        <ThemedText type="title" style={styles.title}>
          {title}
        </ThemedText>

        {disabled ? (
          <ThemedView type="backgroundElement" style={styles.notice}>
            <ThemedText type="small" themeColor="textSecondary">
              {disabledMessage}
            </ThemedText>
          </ThemedView>
        ) : null}

        <TextInput
          testID="email-input"
          placeholder="Email"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          inputMode="email"
          editable={!disabled && !submitting}
          value={email}
          onChangeText={setEmail}
          style={inputStyle}
        />
        <TextInput
          testID="password-input"
          placeholder="Password"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          secureTextEntry
          editable={!disabled && !submitting}
          value={password}
          onChangeText={setPassword}
          style={inputStyle}
        />

        {error !== null ? (
          <ThemedText testID="auth-error" type="small" themeColor="textSecondary" style={styles.error}>
            {error}
          </ThemedText>
        ) : null}

        <Pressable
          testID="submit-button"
          accessibilityRole="button"
          disabled={disabled || submitting}
          onPress={() => void handleSubmit()}
          style={({ pressed }) => [styles.submit, pressed && styles.pressed]}>
          <ThemedView type="backgroundSelected" style={styles.submitInner}>
            <ThemedText type="smallBold">{submitting ? 'Please wait…' : submitLabel}</ThemedText>
          </ThemedView>
        </Pressable>

        <ThemedView style={styles.footer}>{footer}</ThemedView>
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
  },
  form: {
    width: '100%',
    maxWidth: MaxContentWidth / 2,
    gap: Spacing.three,
  },
  title: {
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  error: {
    textAlign: 'center',
  },
  notice: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    alignItems: 'center',
  },
  submit: {
    marginTop: Spacing.one,
  },
  submitInner: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  footer: {
    alignItems: 'center',
    marginTop: Spacing.one,
  },
});
