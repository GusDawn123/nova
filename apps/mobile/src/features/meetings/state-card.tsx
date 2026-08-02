import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChamferSurface } from '@/design/chamfer';
import { RingOrbit } from '@/design/ring-orbit';
import {
  FontFamily,
  FontSize,
  Radius,
  Size,
  Space,
  eyebrowStyle,
  type Palette,
} from '@/design/tokens';

/**
 * The meeting detail's one card for "there is nothing here, and this is why"
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * Every non-content state on this screen — still processing, failed, no notes on an
 * old call, no draft — is the same card with different words, which is the point:
 * the states differ in what they SAY, never in how loudly they say it. There is no
 * alarm colour in this design (spec §11), so an admission and a wait look alike and
 * read differently.
 *
 * `waiting` turns the ring orbit on. It is the indicator for non-live waits (spec
 * §6) — the brand's double ring doing the waiting — and it is never shown next to a
 * failure, which is not waiting for anything.
 */

export interface StateCardProps {
  palette: Palette;
  /** Mono eyebrow naming what the card is about ("NOTES", "TRANSCRIPT"). */
  eyebrow: string;
  /** The sentence. Sentence case — this is copy, not a label. */
  message: string;
  /** A quieter second line: the server's own words, or what happens next. */
  detail?: string;
  /** Ring orbit beside the eyebrow. For waits only. */
  waiting?: boolean;
  /** Drawn only when there is something a press can actually change. */
  action?: { label: string; onPress: () => void; testID?: string };
  testID?: string;
}

export function StateCard({
  palette,
  eyebrow,
  message,
  detail,
  waiting = false,
  action,
  testID,
}: StateCardProps): React.JSX.Element {
  return (
    <View
      testID={testID}
      style={[styles.card, { backgroundColor: palette.inkFill }]}
    >
      <View style={styles.head}>
        <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
          {eyebrow}
        </Text>
        {waiting ? <RingOrbit size={18} color={palette.ink} /> : null}
      </View>
      <Text style={[styles.message, { color: palette.ink }]}>{message}</Text>
      {detail === undefined ? null : (
        <Text style={[styles.detail, { color: palette.inkSoft }]}>{detail}</Text>
      )}
      {action === undefined ? null : (
        <Pressable
          testID={action.testID}
          accessibilityRole="button"
          onPress={action.onPress}
          style={({ pressed }) => (pressed ? styles.pressed : undefined)}
        >
          <ChamferSurface
            stroke={palette.ink}
            style={styles.key}
            contentStyle={styles.keyContent}
          >
            <Text style={[styles.keyLabel, { color: palette.ink }]}>
              {action.label}
            </Text>
          </ChamferSurface>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.soft,
    padding: Space.xl,
    gap: Space.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  eyebrow: eyebrowStyle,
  message: {
    fontFamily: FontFamily.bodySemibold,
    fontSize: FontSize.bodySm,
    lineHeight: FontSize.bodySm * 1.45,
  },
  detail: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.5,
  },
  key: { alignSelf: 'flex-start', marginTop: Space.xs },
  keyContent: {
    minHeight: Size.tapTarget,
    paddingHorizontal: Space.xl,
    justifyContent: 'center',
  },
  keyLabel: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoSm,
    letterSpacing: 2,
  },
  pressed: { opacity: 0.7 },
});
