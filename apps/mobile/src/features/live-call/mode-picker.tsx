import type { LiveMode } from '@nova/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChamferSurface } from '@/design/chamfer';
import { FontFamily, FontSize, Size, Space, type Palette } from '@/design/tokens';

import { MODE_LABELS, MODE_ORDER } from './modes';

/**
 * The copilot mode picker: the row of pills chosen BEFORE the call
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §4).
 *
 * Chamfered, because they act (spec §3), and the picked one is FILLED rather than
 * tinted — the duotone has one ink, so "selected" cannot be a lighter shade of
 * anything. Fill and its inverse text is the only contrast the palette can spend.
 *
 * Mode is per session — the server locks it at `session.start` so the assembled
 * prompt prefix stays byte-stable for the whole call — so the row goes inert once a
 * session is connecting or live rather than pretending a mid-call switch works.
 *
 * Dumb by construction: it holds no state. The picked mode and the lock both come
 * from `useLiveSession`, which is what actually knows whether a call is in flight.
 */

export interface ModePickerProps {
  readonly mode: LiveMode;
  readonly onSelect: (mode: LiveMode) => void;
  /** True while a session is connecting/live — mode is locked for the call. */
  readonly disabled: boolean;
  readonly palette: Palette;
}

export function ModePicker({
  mode,
  onSelect,
  disabled,
  palette,
}: ModePickerProps): React.JSX.Element {
  return (
    // radiogroup/radio rather than buttons: this is one choice out of four, and
    // it is the role that carries the SELECTED state to a screen reader (and to
    // the DOM as aria-checked under react-native-web).
    <View accessibilityRole="radiogroup" style={styles.row}>
      {MODE_ORDER.map((value) => {
        const selected = value === mode;
        return (
          <Pressable
            key={value}
            testID={`mode-pill-${value}`}
            accessibilityRole="radio"
            // `aria-checked` rather than accessibilityState: RN maps the aria-*
            // props onto native accessibility state, and react-native-web renders
            // them as real DOM attributes — accessibilityState.checked reaches
            // neither, so the selected pill would be silent to a screen reader.
            aria-checked={selected}
            disabled={disabled}
            onPress={() => {
              onSelect(value);
            }}
            style={({ pressed }) => [
              styles.pill,
              // Locked reads as unavailable rather than as a fifth unselected pill.
              disabled ? styles.locked : undefined,
              pressed ? styles.pressed : undefined,
            ]}
          >
            <ChamferSurface
              fill={selected ? palette.ink : 'transparent'}
              stroke={selected ? undefined : palette.inkHairline}
              style={styles.surface}
              contentStyle={styles.surfaceContent}
            >
              <Text
                style={[
                  styles.label,
                  { color: selected ? palette.onInk : palette.inkSoft },
                ]}
              >
                {MODE_LABELS[value]}
              </Text>
            </ChamferSurface>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Space.sm2,
  },
  pill: { flex: 1 },
  surface: { minHeight: Size.tapTarget - Space.md },
  surfaceContent: {
    flex: 1,
    paddingVertical: Space.md,
    paddingHorizontal: Space.xs2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontFamily: FontFamily.monoBold,
    fontSize: FontSize.monoXs,
    letterSpacing: 1.5,
    // Uppercase on screen only: the DOM text stays "General", so a screen reader
    // says the word rather than spelling out a shouted one.
    textTransform: 'uppercase',
  },
  locked: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});
