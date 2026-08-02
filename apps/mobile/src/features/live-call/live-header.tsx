import type { LiveMode } from '@nova/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChamferSurface } from '@/design/chamfer';
import {
  FontFamily,
  FontSize,
  Size,
  Space,
  type Palette,
} from '@/design/tokens';
import type { LiveStatus } from '@/hooks/use-live-session';

import { hudLabel } from './call-clock';
import { MODE_LABELS } from './modes';

/**
 * The cockpit's chrome (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4):
 * the header, the rail that divides the two panes, and the one-line banner for a
 * session that is limping.
 *
 * The header is the wordmark on the left and the HUD on the right — `◉ LIVE · mm:ss`
 * in mono, because a clock is machine speech (spec §2). The END key lives up here
 * rather than on the bottom bar: the bar has exactly one key on it (spec §3), and
 * putting the way OUT of a call next to the way to use it is how a call gets ended
 * by accident.
 */

export interface LiveHeaderProps {
  readonly palette: Palette;
  readonly status: LiveStatus;
  readonly elapsedMs: number;
  /** Ends the call. Absent when there is no call to end. */
  readonly onEnd: (() => void) | null;
}

export function LiveHeader({
  palette,
  status,
  elapsedMs,
  onEnd,
}: LiveHeaderProps): React.JSX.Element {
  return (
    <View style={styles.header}>
      <Text style={[styles.wordmark, { color: palette.ink }]}>NOVA</Text>
      <View style={styles.headerRight}>
        <Text
          testID="live-hud"
          style={[
            styles.hud,
            { color: status === 'live' ? palette.ink : palette.inkSoft },
          ]}
        >
          {hudLabel(status, elapsedMs)}
        </Text>
        {onEnd === null ? null : (
          <Pressable
            testID="end-session-key"
            accessibilityRole="button"
            onPress={onEnd}
            style={({ pressed }) => (pressed ? styles.pressed : undefined)}
          >
            <ChamferSurface
              stroke={palette.inkHairline}
              style={styles.endKey}
              contentStyle={styles.endKeyContent}
            >
              <Text style={[styles.endLabel, { color: palette.inkSoft }]}>
                END
              </Text>
            </ChamferSurface>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/**
 * The rail between the two panes: hairline — MODE — hairline.
 *
 * It names the prompt this call is locked to, which is the one thing about the
 * session the user can no longer see anywhere else once the picker goes away.
 */
export function HudRail({
  palette,
  mode,
}: {
  readonly palette: Palette;
  readonly mode: LiveMode;
}): React.JSX.Element {
  return (
    <View style={styles.rail}>
      <View style={[styles.hairline, { backgroundColor: palette.inkHairline }]} />
      <Text
        testID="hud-rail-mode"
        style={[styles.railLabel, { color: palette.inkFaint }]}
      >
        {MODE_LABELS[mode].toUpperCase()}
      </Text>
      <View style={[styles.hairline, { backgroundColor: palette.inkHairline }]} />
    </View>
  );
}

/**
 * One mono line for a session that is degraded, disconnected, or has just refused a
 * frame — the states spec §4 gives a typed banner rather than a screen. It says what
 * happened and offers nothing to press, because the session is still up and there is
 * nothing to do about it from here.
 */
export function SessionBanner({
  palette,
  text,
}: {
  readonly palette: Palette;
  readonly text: string;
}): React.JSX.Element {
  return (
    <Text
      testID="session-banner"
      style={[styles.banner, { color: palette.inkSoft }]}
    >
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  wordmark: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displayMd,
    letterSpacing: 3,
  },
  hud: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
    letterSpacing: 1,
  },
  endKey: { alignSelf: 'center' },
  endKeyContent: {
    minHeight: Size.tapTarget - Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: 0,
    justifyContent: 'center',
  },
  endLabel: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 2,
  },
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  hairline: { flex: 1, height: StyleSheet.hairlineWidth },
  railLabel: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
    letterSpacing: 2.5,
  },
  banner: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
    lineHeight: FontSize.monoXs * 1.6,
    letterSpacing: 0.5,
  },
  pressed: { opacity: 0.7 },
});
