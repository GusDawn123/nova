import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ChamferSurface } from '@/design/chamfer';
import {
  Chamfer,
  FontFamily,
  FontSize,
  Size,
  Space,
  type Palette,
} from '@/design/tokens';

/**
 * The bottom bar — the steer field and the one key
 * (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §3, §4).
 *
 * Two visibly distinct controls, never one merged pill: the field is an outline the
 * user writes into, the key is a solid block of ink they press. Both are chamfered,
 * because both act (spec §3), and the field raises its outline and shows corner
 * brackets while it has focus — the design's whole focus language.
 *
 * The bar owns the DRAFT and nothing else. What the steer means, which answer it
 * belongs to, and whether the socket will take it are all the screen's business;
 * this component's only claims are "here is what they typed" and "the field is
 * empty again now".
 */

/**
 * Spec §4's copy, verbatim.
 *
 * KNOWN MISMATCH, and a deliberate one: on the MVP wire the key is dead while the
 * field is empty (see the bridge note below), so `(optional)` overstates what an
 * empty field can currently do. The word becomes true the moment the manual-trigger
 * event of spec §10 lands, and changing ratified copy for the duration of a bridge
 * would leave the wrong words in place afterwards.
 */
export const STEER_PLACEHOLDER = 'Steer the answer (optional)…';

/** The wire bound on a `transcript.input`; the field refuses to exceed it. */
const STEER_MAX_LENGTH = 2000;

export interface SteerBarProps {
  readonly palette: Palette;
  /** Whether the socket is up and will take input at all. */
  readonly canSend: boolean;
  /** The steer, trimmed and non-empty. The field is cleared by the time it fires. */
  readonly onRespond: (steer: string) => void;
}

export function SteerBar({
  palette,
  canSend,
  onRespond,
}: SteerBarProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);

  const steer = draft.trim();
  // why: the MVP bridge (spec §10). RESPOND rides the EXISTING `transcript.input`
  // wire, which carries text or nothing — there is no manual-trigger event yet, so
  // an empty-field press has nothing to send and the key stays dead rather than
  // pretending. When §10's trigger event lands, this condition drops to `canSend`
  // and the empty press means "answer the moment at the end of the transcript".
  const armed = canSend && steer !== '';

  const respond = (): void => {
    if (!armed) return;
    setDraft('');
    onRespond(steer);
  };

  return (
    <View style={styles.row}>
      <ChamferSurface
        stroke={focused ? palette.ink : palette.inkHairline}
        brackets={focused}
        style={styles.field}
        contentStyle={styles.fieldContent}
      >
        <TextInput
          testID="steer-field"
          style={[styles.input, { color: palette.ink }]}
          placeholder={STEER_PLACEHOLDER}
          placeholderTextColor={palette.inkFaint}
          value={draft}
          onChangeText={setDraft}
          onFocus={() => {
            setFocused(true);
          }}
          onBlur={() => {
            setFocused(false);
          }}
          onSubmitEditing={respond}
          returnKeyType="send"
          maxLength={STEER_MAX_LENGTH}
          multiline={false}
          editable={canSend}
        />
      </ChamferSurface>

      <Pressable
        testID="respond-key"
        accessibilityRole="button"
        accessibilityLabel="Respond"
        disabled={!armed}
        onPress={respond}
        style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      >
        <ChamferSurface
          cut={Chamfer.key}
          // Disabled is a QUIETER version of the same block, not an outline: the key
          // must stay the heaviest thing on the bar so the eye keeps its place.
          fill={armed ? palette.ink : palette.inkFill}
          style={styles.key}
          contentStyle={styles.keyContent}
        >
          <Text
            style={[
              styles.keyLabel,
              { color: armed ? palette.onInk : palette.inkFaint },
            ]}
          >
            ◉ RESPOND
          </Text>
        </ChamferSurface>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Space.sm2,
  },
  field: { flex: 1, minHeight: Size.tapTarget },
  fieldContent: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 0,
    paddingHorizontal: Space.md,
  },
  input: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.mono,
  },
  key: { minHeight: Size.tapTarget },
  keyContent: {
    flex: 1,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyLabel: {
    fontFamily: FontFamily.display,
    fontSize: FontSize.displaySm,
    letterSpacing: 1.5,
  },
  pressed: { opacity: 0.7 },
});
