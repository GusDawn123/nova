import { StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';

import { useCaret } from '@/design/motion';
import { FontSize } from '@/design/tokens';

/**
 * The blinking block at the end of the Meetings empty state's standby readout
 * (`app/(app)/(tabs)/index.tsx`).
 *
 * It carries no `decorative` spread of its own: its only caller sits inside the
 * readout container, which is wholly decorative and already hidden from assistive
 * tech there. A future caller outside such a container owns that call itself.
 */

/**
 * Caret block: 5pt wide, one monoXs line tall — sized to its line the way stream's
 * caret is sized to body (`features/stream/streaming-text.tsx` CARET_WIDTH/HEIGHT),
 * scaled down because the readout whispers where the teleprompter speaks.
 */
const READOUT_CARET_WIDTH = 5;
const READOUT_CARET_HEIGHT = FontSize.monoXs;

/**
 * The readout's write-head. An inline View inside Text is the app's caret idiom —
 * `features/stream/streaming-text.tsx` established it: the block rides the line's
 * baseline instead of falling after the paragraph box. Its blink is the shared
 * square-wave, so it keeps time with every other caret in the app.
 */
export function ReadoutCaret({ color }: { color: string }): React.JSX.Element {
  const blink = useCaret();
  return (
    <Animated.View style={[styles.caret, { backgroundColor: color }, blink]} />
  );
}

const styles = StyleSheet.create({
  caret: { width: READOUT_CARET_WIDTH, height: READOUT_CARET_HEIGHT },
});
