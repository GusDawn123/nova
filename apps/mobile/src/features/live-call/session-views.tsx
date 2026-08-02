import type { LiveMode } from '@nova/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChamferSurface } from '@/design/chamfer';
import { LightSweep } from '@/design/light-sweep';
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

import { ModePicker } from './mode-picker';

/**
 * The Live screen when it is not a cockpit
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4 — Live screen states).
 *
 * Three views, and the difference between them is what they SAY, never how loudly:
 * the duotone has no alarm colour (spec §11), so a spent quota and a finished call
 * are the same card with different words.
 *
 * The mascot is deliberately absent from all three. This is a working surface, and
 * she never appears on one (spec §7) — even when it is idle, because the next thing
 * that happens here is a call starting.
 */

export interface IdlePanelProps {
  readonly palette: Palette;
  readonly mode: LiveMode;
  readonly onSelectMode: (mode: LiveMode) => void;
  readonly canPickMode: boolean;
  readonly onStart: () => void;
}

/** Before the call: which prompt answers it, and the key that starts it. */
export function IdlePanel({
  palette,
  mode,
  onSelectMode,
  canPickMode,
  onStart,
}: IdlePanelProps): React.JSX.Element {
  return (
    <View testID="idle-panel" style={styles.idle}>
      <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
        WHO SHE ANSWERS AS
      </Text>
      <ModePicker
        mode={mode}
        onSelect={onSelectMode}
        disabled={!canPickMode}
        palette={palette}
      />
      <Text style={[styles.note, { color: palette.inkSoft }]}>
        The mode is locked for the whole call, so pick it before you start.
      </Text>

      <Pressable
        testID="start-session-key"
        accessibilityRole="button"
        // The glyph is decoration, per `app-tabs.tsx`: `◉ START SESSION` read
        // literally is noise, and most screen readers say nothing for a fisheye.
        accessibilityLabel="Start session"
        onPress={onStart}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <ChamferSurface
          cut={Chamfer.key}
          fill={palette.ink}
          style={styles.key}
          contentStyle={styles.keyContent}
        >
          <Text style={[styles.keyLabel, { color: palette.onInk }]}>
            ◉ START SESSION
          </Text>
        </ChamferSurface>
      </Pressable>
    </View>
  );
}

/**
 * The handoff row after a call ends: the notes are being written, and here is the
 * way to them. The sweep is the honest signal for that wait (spec §6) — the pipeline
 * reports no progress, so nothing here claims any.
 *
 * The link goes to the ARCHIVE rather than to this call: `useLiveSession` does not
 * expose the meeting id it created, and inventing a route from a guess would be a
 * worse answer than the list the call is at the top of.
 */
export function EndedSummary({
  palette,
  onSeeCalls,
}: {
  readonly palette: Palette;
  readonly onSeeCalls: () => void;
}): React.JSX.Element {
  return (
    <View
      testID="ended-summary"
      style={[styles.card, { backgroundColor: palette.inkFill }]}
    >
      <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
        WRITING NOTES
      </Text>
      <LightSweep color={palette.ink} style={styles.sweep} />
      <Text style={[styles.message, { color: palette.ink }]}>
        That call is done. She is reading it back now.
      </Text>
      <Pressable
        testID="see-calls-key"
        accessibilityRole="button"
        onPress={onSeeCalls}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <ChamferSurface
          stroke={palette.ink}
          style={styles.linkKey}
          contentStyle={styles.linkKeyContent}
        >
          <Text style={[styles.linkLabel, { color: palette.ink }]}>
            SEE YOUR CALLS
          </Text>
        </ChamferSurface>
      </Pressable>
    </View>
  );
}

/**
 * A spent quota, which ends the call from the server's side.
 *
 * Plain copy and NOTHING to press: no press on this screen mints more quota, and a
 * retry that cannot work is worse than no button at all (the posture the signed-out
 * card on Meetings already takes).
 */
export function QuotaCard({
  palette,
}: {
  readonly palette: Palette;
}): React.JSX.Element {
  return (
    <View
      testID="quota-card"
      style={[styles.card, styles.quota, { backgroundColor: palette.inkFill }]}
    >
      <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
        OUT OF CALL TIME
      </Text>
      <Text style={[styles.message, { color: palette.ink }]}>
        Your plan&apos;s live call time is used up for this period, so this call has
        ended.
      </Text>
      <Text style={[styles.note, { color: palette.inkSoft }]}>
        Nothing else changed — every call you have already had, and the notes she
        wrote for them, are still here. You can start another call below, and the
        server will refuse it until your plan renews.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  idle: { gap: Space.md },
  eyebrow: eyebrowStyle,
  note: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.5,
  },
  message: {
    fontFamily: FontFamily.bodySemibold,
    fontSize: FontSize.bodySm,
    lineHeight: FontSize.bodySm * 1.45,
  },
  key: {
    minHeight: Size.tapTarget,
    justifyContent: 'center',
    marginTop: Space.sm2,
  },
  keyContent: {
    paddingVertical: Space.lg,
    paddingHorizontal: Space.xxl,
    alignItems: 'center',
  },
  keyLabel: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displaySm,
    letterSpacing: 2,
  },
  card: {
    borderRadius: Radius.soft,
    padding: Space.xl,
    gap: Space.md,
  },
  quota: { marginTop: Space.xl },
  sweep: { alignSelf: 'stretch' },
  linkKey: { alignSelf: 'flex-start', marginTop: Space.xs },
  linkKeyContent: {
    minHeight: Size.tapTarget,
    paddingHorizontal: Space.xl,
    justifyContent: 'center',
  },
  linkLabel: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoSm,
    letterSpacing: 2,
  },
  pressed: { opacity: 0.7 },
});
