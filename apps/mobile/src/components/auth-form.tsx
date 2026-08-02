import { useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { ChamferSurface } from '@/design/chamfer';
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
import { usePalette } from '@/hooks/use-appearance';
import type { AuthActionResult, AuthErrorKind } from '@/hooks/use-auth';

/**
 * The front door (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §8).
 *
 * One centred column: her, the wordmark, what Nova is for, the fields, one key.
 * Sign-in and sign-up are the SAME door — sign-up only adds a confirm field — so
 * they share this component and differ in the two props they pass.
 *
 * Dumb, as before: it owns its field/submit/error view state and nothing else. The
 * auth call arrives as `onSubmit` and comes back as a typed result, which is what
 * lets this file decide how a failure LOOKS without knowing what failed.
 *
 * Errors are said in words and emphasised in ink (spec §11): the message is plain
 * copy under the fields in `inkSoft`, and the fields the failure implicates raise
 * their outline from the resting hairline to full ink. There is no red, because
 * there is no third colour in this design at all.
 */

/** Spec §8: she is SMALL here — the ring and the wordmark carry the block. */
const MASCOT_SIZE = 120;
/** Her box, plus a ring of breathing room, then the hairline outside that. */
const RING_INNER = MASCOT_SIZE + Space.md * 2;
const RING_OUTER = RING_INNER + Space.md;
const RING_INNER_WIDTH = 2;
const RING_OUTER_WIDTH = 1.5;
/** The column never grows past a phone's comfortable measure, even on a tablet. */
const COLUMN_MAX_WIDTH = 340;
/** Wordmark tracking (spec §8: "Orbitron 900, wide tracking"). */
const WORDMARK_TRACKING = 8;

type FieldName = 'email' | 'password' | 'confirm';

interface FormError {
  message: string;
  /** Fields to raise to full ink. Empty when the failure implicates none of them. */
  fields: readonly FieldName[];
}

/**
 * Which fields a failure points at. Bad credentials are the pair — the server will
 * not say which half was wrong, and guessing would be worse than marking both —
 * while a network or config failure is about neither, so nothing is marked.
 */
function fieldsFor(kind: AuthErrorKind): readonly FieldName[] {
  return kind === 'invalid-credentials' ? ['email', 'password'] : [];
}

export interface AuthFormProps {
  /** The word on the key. Display type, so it arrives already uppercase. */
  submitLabel: string;
  onSubmit: (email: string, password: string) => Promise<AuthActionResult>;
  /** Footer slot — typically the link to the other auth screen. */
  footer: ReactNode;
  /** When set, the form is inert and shows this message (e.g. auth unavailable). */
  disabledMessage?: string;
  /** Sign-up mirrors sign-in with a confirm field; sign-in has none. */
  confirmPassword?: boolean;
}

export function AuthForm({
  submitLabel,
  onSubmit,
  footer,
  disabledMessage,
  confirmPassword = false,
}: AuthFormProps) {
  const palette = usePalette();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<FormError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const disabled = disabledMessage !== undefined;
  // Nothing to submit is not an error worth showing — it is a key that has not lit
  // up yet. The round trip it would make can only fail.
  const incomplete =
    email.trim() === '' || password === '' || (confirmPassword && confirm === '');
  const inert = disabled || submitting || incomplete;

  async function handleSubmit(): Promise<void> {
    setError(null);
    if (confirmPassword && confirm !== password) {
      // Caught here rather than at the server: the answer is already known, and a
      // round trip would only delay it.
      setError({ message: 'Those two passwords do not match.', fields: ['confirm'] });
      return;
    }
    setSubmitting(true);
    const result = await onSubmit(email.trim(), password);
    setSubmitting(false);
    if (!result.ok) {
      setError({ message: result.message, fields: fieldsFor(result.kind) });
    }
    // On success the auth-state change drives navigation (the (auth) layout
    // redirects a signed-in user away), so there is nothing to do here.
  }

  return (
    // SCROLLABLE, not a centred flex box. Sign-up's column is ~500pt tall; on a 667pt
    // device the keyboard takes ~290pt of that, which would leave the key and the
    // footer under it with no way to reach them — and an overflowing centred View
    // clips rather than scrolls. `flexGrow` + `justifyContent` on the CONTENT style
    // keeps the short case (sign-in, no keyboard) centred exactly as before.
    <ScrollView
      testID="auth-scroll"
      style={[styles.screen, { backgroundColor: palette.canvas }]}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      // iOS only, and load-bearing there: the keyboard COVERS a scroll view rather
      // than shrinking it, so on an SE-class screen the column below the focused
      // field is behind the keyboard with no scroll range to reach it — scrollable
      // in principle, immovable in practice. This adds the keyboard's height as a
      // bottom content inset, which is what turns the range back on. The live
      // screen solves the same problem with `KeyboardAvoidingView` because its
      // steer bar is pinned to the bottom; here the whole column scrolls, so the
      // inset is the smaller instrument.
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.column}>
        <View
          testID="mascot-ring-outer"
          style={[styles.ringOuter, { borderColor: palette.inkHairline }]}
        >
          <View
            testID="mascot-ring-inner"
            style={[styles.ringInner, { borderColor: palette.ink }]}
          >
            {/* Sparkles come WITH her — the stage draws them; nothing here adds any. */}
            <MascotStage size={MASCOT_SIZE} color={palette.ink} />
          </View>
        </View>

        <Text style={[styles.wordmark, { color: palette.ink }]}>NOVA</Text>
        <Text style={[styles.eyebrow, { color: palette.inkSoft }]}>
          YOUR LIVE-CALL COPILOT
        </Text>

        {disabled ? (
          <View style={[styles.notice, { backgroundColor: palette.inkFill }]}>
            <Text style={[styles.noticeText, { color: palette.inkSoft }]}>
              {disabledMessage}
            </Text>
          </View>
        ) : null}

        <Field
          name="email"
          placeholder="EMAIL"
          value={email}
          onChangeText={setEmail}
          invalid={error?.fields.includes('email') ?? false}
          editable={!disabled && !submitting}
          palette={palette}
          autoComplete="email"
          keyboardType="email-address"
          inputMode="email"
        />
        <Field
          name="password"
          placeholder="PASSWORD"
          value={password}
          onChangeText={setPassword}
          invalid={error?.fields.includes('password') ?? false}
          editable={!disabled && !submitting}
          palette={palette}
          secureTextEntry
        />
        {confirmPassword ? (
          <Field
            name="confirm"
            placeholder="CONFIRM PASSWORD"
            value={confirm}
            onChangeText={setConfirm}
            invalid={error?.fields.includes('confirm') ?? false}
            editable={!disabled && !submitting}
            palette={palette}
            secureTextEntry
          />
        ) : null}

        {error !== null ? (
          <Text testID="auth-error" style={[styles.error, { color: palette.inkSoft }]}>
            {error.message}
          </Text>
        ) : null}

        <Pressable
          testID="submit-button"
          accessibilityRole="button"
          aria-disabled={inert}
          disabled={inert}
          onPress={() => void handleSubmit()}
          style={({ pressed }) => [styles.key, pressed && styles.pressed]}
        >
          <ChamferSurface
            cut={Chamfer.key}
            fill={palette.ink}
            style={styles.keySurface}
            contentStyle={styles.keyContent}
          >
            <Text style={[styles.keyLabel, { color: palette.onInk }]}>
              {submitting ? 'PLEASE WAIT…' : submitLabel}
            </Text>
          </ChamferSurface>
        </Pressable>

        <View style={styles.footer}>{footer}</View>
      </View>
    </ScrollView>
  );
}

type FieldProps = {
  name: FieldName;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  /** Raised to full ink by a failure that implicates this field. */
  invalid: boolean;
  editable: boolean;
  palette: Palette;
} & Pick<
  TextInputProps,
  'autoComplete' | 'keyboardType' | 'inputMode' | 'secureTextEntry'
>;

/**
 * One chamfered field. Focus owns its own state because nothing outside the field
 * needs to know, and both focus and failure resolve to the same two knobs the
 * primitive offers: the outline colour, and whether the corner brackets are drawn.
 */
function Field({
  name,
  placeholder,
  value,
  onChangeText,
  invalid,
  editable,
  palette,
  ...input
}: FieldProps) {
  const [focused, setFocused] = useState(false);
  const raised = focused || invalid;

  return (
    <ChamferSurface
      testID={`field-${name}`}
      stroke={raised ? palette.ink : palette.inkHairline}
      brackets={focused}
      style={styles.field}
      contentStyle={styles.fieldContent}
    >
      <TextInput
        testID={`${name}-input`}
        placeholder={placeholder}
        placeholderTextColor={palette.inkFaint}
        selectionColor={palette.ink}
        autoCapitalize="none"
        editable={editable}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        style={[styles.input, { color: palette.ink }]}
        {...input}
      />
    </ChamferSurface>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // The centring lives on the CONTENT: `flexGrow` lets a short column sit in the
  // middle of the viewport while a tall one grows past it and scrolls.
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Space.xl,
    paddingVertical: Space.xxl,
  },
  column: {
    width: '100%',
    maxWidth: COLUMN_MAX_WIDTH,
    alignItems: 'stretch',
    gap: Space.md,
  },
  ringOuter: {
    alignSelf: 'center',
    width: RING_OUTER,
    height: RING_OUTER,
    borderRadius: Radius.pill,
    borderWidth: RING_OUTER_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringInner: {
    width: RING_INNER,
    height: RING_INNER,
    borderRadius: Radius.pill,
    borderWidth: RING_INNER_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displayXl,
    letterSpacing: WORDMARK_TRACKING,
    textAlign: 'center',
    marginTop: Space.sm,
  },
  eyebrow: {
    ...eyebrowStyle,
    textAlign: 'center',
    marginBottom: Space.md,
  },
  notice: {
    padding: Space.lg,
    borderRadius: Radius.chip,
  },
  noticeText: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    textAlign: 'center',
  },
  field: {
    minHeight: Size.tapTarget,
    justifyContent: 'center',
  },
  // Tighter than the cut's own inset: the chamfer only eats into the corners, and a
  // full inset on all four sides would leave the text floating in the middle.
  fieldContent: {
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  input: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.mono,
    letterSpacing: 1,
  },
  error: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.4,
  },
  key: {
    marginTop: Space.xs,
  },
  keySurface: {
    minHeight: Size.tapTarget,
    justifyContent: 'center',
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
  pressed: {
    opacity: 0.7,
  },
  footer: {
    alignItems: 'center',
    marginTop: Space.sm,
  },
});
