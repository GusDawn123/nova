import { liveModeSchema, type LiveMode } from '@nova/shared';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/**
 * The copilot mode picker: a row of segmented pills chosen BEFORE the call.
 *
 * Mode is per session — the server locks it at `session.start` so the assembled
 * prompt prefix stays byte-stable for the whole call — so the row goes inert once
 * a session is connecting or live rather than pretending a mid-call switch works.
 *
 * Dumb by construction: it holds no state. The picked mode and the lock both come
 * from `useLiveSession`, which is what actually knows whether a call is in flight.
 */

/**
 * Picker copy per mode. A `Record<LiveMode, string>` on purpose: a mode added to
 * the wire enum fails to compile here until it has a label, so the picker cannot
 * silently offer three of four modes.
 */
const MODE_LABELS: Record<LiveMode, string> = {
  general: 'General',
  behavioral: 'Behavioral',
  technical: 'Technical',
  finance: 'Finance',
};

/** Order comes from the enum itself, so the row and the wire cannot disagree. */
const MODE_ORDER: readonly LiveMode[] = liveModeSchema.options;

export interface ModePickerProps {
  readonly mode: LiveMode;
  readonly onSelect: (mode: LiveMode) => void;
  /** True while a session is connecting/live — mode is locked for the call. */
  readonly disabled: boolean;
}

export function ModePicker({ mode, onSelect, disabled }: ModePickerProps) {
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
            style={({ pressed }) => (pressed ? styles.pressed : undefined)}
          >
            <ThemedView
              type={selected ? 'backgroundSelected' : 'backgroundElement'}
              style={[styles.pill, disabled && styles.locked]}
            >
              <ThemedText
                type={selected ? 'smallBold' : 'small'}
                themeColor={selected ? 'text' : 'textSecondary'}
              >
                {MODE_LABELS[value]}
              </ThemedText>
            </ThemedView>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  pill: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  // Locked reads as unavailable rather than as a fourth unselected pill.
  locked: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.7,
  },
});
