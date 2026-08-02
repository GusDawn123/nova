import type { MeetingNotes } from '@nova/shared';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { ChamferSurface } from '@/design/chamfer';
import { useCardInTransformOnly } from '@/design/motion';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  eyebrowStyle,
  type Palette,
} from '@/design/tokens';

/**
 * The Notes view (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5): the
 * tl;dr, then what the call committed to, then what it left open.
 *
 * Cards are SOFT — square-ish corners, no chamfer — because they are read, not
 * pressed (spec §3). The one control among them is the checkbox, which is therefore
 * the one chamfered shape on the screen; the tl;dr takes the ink wash so the eye
 * starts there without a second size or a second colour.
 *
 * A section with nothing in it is not drawn at all. An empty "Decisions" heading
 * reads as a call that decided nothing, which is a claim, and not the one the
 * pipeline made.
 *
 * Entrance is TRANSFORM-ONLY — see `design/motion.ts` on the opacity trap. The text
 * IS the content here, so a ramp that never finishes must not be able to hide it.
 */

export interface NotesPanelProps {
  notes: MeetingNotes;
  palette: Palette;
  completedIds: ReadonlySet<string>;
  onToggleItem: (itemId: string, completed: boolean) => void;
}

export function NotesPanel({
  notes,
  palette,
  completedIds,
  onToggleItem,
}: NotesPanelProps): React.JSX.Element {
  return (
    <ScrollView
      testID="notes-panel"
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      <Card palette={palette} eyebrow="TL;DR" delay={0} filled>
        <Text style={[styles.tldr, { color: palette.ink }]}>{notes.tldr}</Text>
      </Card>

      {notes.actionItems.length > 0 ? (
        <Card
          palette={palette}
          eyebrow="ACTION ITEMS"
          count={notes.actionItems.length}
          delay={60}
        >
          {notes.actionItems.map((item) => (
            <ActionItemRow
              key={item.id}
              palette={palette}
              id={item.id}
              text={item.text}
              owner={item.owner}
              deadlineRaw={item.deadlineRaw}
              checked={completedIds.has(item.id)}
              onToggle={onToggleItem}
            />
          ))}
        </Card>
      ) : null}

      {notes.decisions.length > 0 ? (
        <Card palette={palette} eyebrow="DECISIONS" delay={120}>
          {notes.decisions.map((decision) => (
            <View key={decision.id} style={styles.decision}>
              <Text style={[styles.body, { color: palette.ink }]}>
                {decision.text}
              </Text>
              {/* A null quote means no direct evidence in the transcript. Render
                  nothing rather than an empty rule — the absence is the signal. */}
              {decision.quote !== null ? (
                <Text
                  style={[
                    styles.quote,
                    {
                      color: palette.inkSoft,
                      borderLeftColor: palette.inkHairline,
                    },
                  ]}
                >
                  {`“${decision.quote}”`}
                </Text>
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}

      {notes.openQuestions.length > 0 ? (
        <Card palette={palette} eyebrow="OPEN" delay={180}>
          {notes.openQuestions.map((question) => (
            <Text
              key={question.id}
              style={[styles.body, { color: palette.inkSoft }]}
            >
              {question.text}
            </Text>
          ))}
        </Card>
      ) : null}

      {notes.risks.length > 0 ? (
        // Said in words at reading strength, never in a warning colour — the
        // palette has one ink, and risk is a sentence (spec §11).
        <Card palette={palette} eyebrow="RISKS" delay={240}>
          {notes.risks.map((risk) => (
            <Text key={risk.id} style={[styles.body, { color: palette.inkSoft }]}>
              {risk.text}
            </Text>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

function ActionItemRow({
  palette,
  id,
  text,
  owner,
  deadlineRaw,
  checked,
  onToggle,
}: {
  palette: Palette;
  id: string;
  text: string;
  owner: string | null;
  deadlineRaw: string | null;
  checked: boolean;
  onToggle: (itemId: string, completed: boolean) => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      // `aria-checked` as well: react-native-web renders the aria-* props as real
      // DOM attributes, and accessibilityState alone reaches neither the DOM nor a
      // web screen reader — the tick would be the only signal, and a tick is a
      // picture.
      aria-checked={checked}
      accessibilityLabel={text}
      testID={`action-item-${id}`}
      onPress={() => {
        onToggle(id, !checked);
      }}
      style={({ pressed }) => [
        styles.actionRow,
        pressed ? styles.pressed : undefined,
      ]}
    >
      <ChamferSurface
        cut={CHECKBOX_CUT}
        fill={checked ? palette.ink : 'transparent'}
        stroke={checked ? undefined : palette.inkHairline}
        style={styles.checkbox}
        contentStyle={styles.checkboxContent}
      >
        {/* Colour comes from `palette.onInk`: the glyph sits on an ink-filled box,
            so it is the canvas colour in whichever theme is painting. */}
        {checked ? (
          <Text style={[styles.checkGlyph, { color: palette.onInk }]}>
            {'✓'}
          </Text>
        ) : null}
      </ChamferSurface>
      <View style={styles.actionText}>
        <Text
          style={[
            styles.body,
            { color: checked ? palette.inkSoft : palette.ink },
            checked ? styles.struck : undefined,
          ]}
        >
          {text}
        </Text>
        {owner !== null || deadlineRaw !== null ? (
          <View style={styles.metaRow}>
            {owner !== null ? (
              <Text style={[styles.meta, { color: palette.inkSoft }]}>
                {owner.toUpperCase()}
              </Text>
            ) : null}
            {owner !== null && deadlineRaw !== null ? (
              <Text style={[styles.meta, { color: palette.inkFaint }]}>·</Text>
            ) : null}
            {/* The SPOKEN phrase, not the ISO date: "Thursday" is what was said and
                what the user will recognise. */}
            {deadlineRaw !== null ? (
              <Text style={[styles.meta, { color: palette.inkSoft }]}>
                {deadlineRaw}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * One section. `filled` takes the ink wash (the tl;dr); everything else is outlined,
 * which is the same soft-card language the meetings list uses for a card you read.
 */
function Card({
  palette,
  eyebrow,
  count,
  delay,
  filled = false,
  children,
}: {
  palette: Palette;
  eyebrow: string;
  count?: number;
  delay: number;
  filled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const entrance = useCardInTransformOnly(delay);
  return (
    <Animated.View
      style={[
        entrance,
        styles.card,
        filled
          ? { backgroundColor: palette.inkFill }
          : { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.inkHairline },
      ]}
    >
      <View style={styles.cardHead}>
        {/* Written uppercase rather than transformed: `textTransform` leaves the DOM
            text mixed-case, which is a difference a screen reader hears. */}
        <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>
          {eyebrow}
        </Text>
        {count === undefined ? null : (
          <Text style={[styles.count, { color: palette.inkFaint }]}>
            {String(count)}
          </Text>
        )}
      </View>
      {children}
    </Animated.View>
  );
}

/** The checkbox cut — tighter than `Chamfer.control`, which would eat a 13pt box. */
const CHECKBOX_CUT = 4;
/** Spec §5: 13px. */
const CHECKBOX_SIZE = 13;

const styles = StyleSheet.create({
  scroll: {
    gap: Space.md,
    paddingBottom: Space.xxl,
  },
  card: {
    borderRadius: Radius.soft,
    padding: Space.lg,
    gap: Space.md,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: eyebrowStyle,
  count: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoSm,
  },
  tldr: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.body,
    lineHeight: FontSize.body * 1.5,
  },
  body: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodySm,
    lineHeight: FontSize.bodySm * 1.45,
  },
  decision: { gap: Space.xs2 },
  quote: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.45,
    fontStyle: 'italic',
    paddingLeft: Space.md,
    borderLeftWidth: 2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: Space.md,
    alignItems: 'flex-start',
  },
  checkbox: {
    width: CHECKBOX_SIZE,
    height: CHECKBOX_SIZE,
    marginTop: 3,
  },
  checkboxContent: {
    flex: 1,
    padding: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkGlyph: { fontSize: 9, lineHeight: 11 },
  actionText: { flex: 1, gap: Space.xs },
  struck: { textDecorationLine: 'line-through' },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Space.xs2,
  },
  meta: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
    letterSpacing: 0.5,
  },
  pressed: { opacity: 0.7 },
});
