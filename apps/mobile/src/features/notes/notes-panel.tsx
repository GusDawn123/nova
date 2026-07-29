import type { MeetingNotes } from '@nova/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { GlassSurface } from '@/design/glass';
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
 * The Notes tab (Phase 8.5, `docs/DESIGN/notes-ui.md` §7.4): tl;dr, decisions with
 * their verbatim quotes, action items with working checkboxes, open questions and
 * risks side by side, then the insights placeholder.
 *
 * All cards enter with {@link useCardInTransformOnly} — they wrap glass, and an
 * opacity ramp from 0 would stop the glass rendering (see `design/motion.ts`).
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
    <View style={styles.stack}>
      <Card palette={palette} delay={0} raised>
        <Eyebrow palette={palette}>tl;dr</Eyebrow>
        <Text style={[styles.tldr, { color: palette.ink }]}>{notes.tldr}</Text>
      </Card>

      {notes.decisions.length > 0 ? (
        <Card palette={palette} delay={60}>
          <Eyebrow palette={palette}>decisions</Eyebrow>
          {notes.decisions.map((decision, i) => (
            <View key={decision.id} style={styles.decision}>
              {i > 0 ? (
                <View
                  style={[styles.divider, { backgroundColor: palette.stroke }]}
                />
              ) : null}
              <Text style={[styles.body, { color: palette.ink }]}>
                {decision.text}
              </Text>
              {/* A null quote means no direct evidence in the transcript. Render
                  nothing rather than an empty rule — the absence is the signal. */}
              {decision.quote !== null ? (
                <Text
                  style={[
                    styles.quote,
                    { color: palette.ink3, borderLeftColor: palette.accentSoft },
                  ]}
                >
                  {`“${decision.quote}”`}
                </Text>
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}

      {notes.actionItems.length > 0 ? (
        <Card palette={palette} delay={120}>
          <View style={styles.cardHead}>
            <Eyebrow palette={palette}>action items</Eyebrow>
            <Text style={[styles.count, { color: palette.ink3 }]}>
              {String(notes.actionItems.length)}
            </Text>
          </View>
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

      {notes.openQuestions.length > 0 || notes.risks.length > 0 ? (
        <View style={styles.pairRow}>
          {notes.openQuestions.length > 0 ? (
            <Card palette={palette} delay={180} style={styles.pairCard}>
              <Eyebrow palette={palette}>open</Eyebrow>
              {notes.openQuestions.map((q) => (
                <Text
                  key={q.id}
                  style={[styles.pairText, { color: palette.ink2 }]}
                >
                  {q.text}
                </Text>
              ))}
            </Card>
          ) : null}
          {notes.risks.length > 0 ? (
            <Card palette={palette} delay={210} style={styles.pairCard}>
              <Text style={[styles.eyebrow, { color: palette.hot }]}>risk</Text>
              {notes.risks.map((r) => (
                <Text
                  key={r.id}
                  style={[styles.pairText, { color: palette.ink2 }]}
                >
                  {r.text}
                </Text>
              ))}
            </Card>
          ) : null}
        </View>
      ) : null}

      <InsightsPlaceholder palette={palette} kind={notes.typeInsights.kind} />
    </View>
  );
}

/**
 * The insights slot, held at "coming soon" (Gustavo, 2026-07-28).
 *
 * The data behind it — objections/buying-signals for sales, questions-asked/
 * answers-to-revisit for interviews — is real and populated, but the prompts that
 * produce it are being refined, so the card holds the layout without making claims
 * yet. Turning it on later is a swap inside this component, not a layout change.
 *
 * A `casual` call has no insights arm, so it renders NOTHING rather than promising
 * something that will never arrive for it.
 */
function InsightsPlaceholder({
  palette,
  kind,
}: {
  palette: Palette;
  kind: MeetingNotes['typeInsights']['kind'];
}): React.JSX.Element | null {
  if (kind === 'casual') return null;

  const label = kind === 'sales' ? 'sales signals' : 'interview signals';
  return (
    <Card palette={palette} delay={240}>
      <View style={styles.cardHead}>
        <Eyebrow palette={palette}>{label}</Eyebrow>
        <View
          style={[
            styles.soonChip,
            { backgroundColor: palette.glass, borderColor: palette.stroke },
          ]}
        >
          <Text style={[styles.soonText, { color: palette.ink3 }]}>
            coming soon
          </Text>
        </View>
      </View>
      <Text style={[styles.pairText, { color: palette.ink3 }]}>
        {kind === 'sales'
          ? 'Objections raised and buying signals detected will appear here.'
          : 'Questions asked and answers worth revisiting will appear here.'}
      </Text>
    </Card>
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
      accessibilityLabel={text}
      testID={`action-item-${id}`}
      onPress={() => {
        onToggle(id, !checked);
      }}
      style={styles.actionRow}
    >
      <View
        style={[
          styles.checkbox,
          { borderColor: checked ? palette.accent : palette.stroke2 },
          checked && { backgroundColor: palette.accent },
        ]}
      >
        {checked ? <Text style={styles.checkGlyph}>{'✓'}</Text> : null}
      </View>
      <View style={styles.actionText}>
        <Text
          style={[
            styles.body,
            { color: checked ? palette.ink3 : palette.ink },
            checked && styles.struck,
          ]}
        >
          {text}
        </Text>
        {owner !== null || deadlineRaw !== null ? (
          <View style={styles.metaRow}>
            {owner !== null ? (
              <View
                style={[styles.metaChip, { backgroundColor: palette.accentFill }]}
              >
                <Text style={[styles.metaText, { color: palette.ink }]}>
                  {owner}
                </Text>
              </View>
            ) : null}
            {/* The SPOKEN phrase, not the ISO date: "Thursday" is what was said and
                what the user will recognise. */}
            {deadlineRaw !== null ? (
              <View
                style={[
                  styles.metaChip,
                  {
                    backgroundColor: palette.glass,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: palette.stroke,
                  },
                ]}
              >
                <Text style={[styles.metaText, { color: palette.ink2 }]}>
                  {deadlineRaw}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function Card({
  palette,
  children,
  delay,
  raised = false,
  style,
}: {
  palette: Palette;
  children: React.ReactNode;
  delay: number;
  raised?: boolean;
  style?: object;
}): React.JSX.Element {
  const entrance = useCardInTransformOnly(delay);
  return (
    <Animated.View style={[entrance, style]}>
      <GlassSurface
        palette={palette}
        tone={raised ? 'raised' : 'regular'}
        radius={Radius.card}
        elevated={raised}
        style={styles.card}
      >
        {children}
      </GlassSurface>
    </Animated.View>
  );
}

function Eyebrow({
  palette,
  children,
}: {
  palette: Palette;
  children: string;
}): React.JSX.Element {
  return (
    <Text style={[styles.eyebrow, { color: palette.ink3 }]}>{children}</Text>
  );
}

const styles = StyleSheet.create({
  stack: { gap: Space.lg },
  card: { padding: Space.xl, gap: Space.md },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: { ...eyebrowStyle },
  count: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.captionSmall,
  },
  tldr: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.tldr,
    lineHeight: FontSize.tldr * 1.5,
  },
  decision: { gap: 6 },
  divider: { height: StyleSheet.hairlineWidth, marginBottom: Space.md },
  body: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.body,
    lineHeight: FontSize.body * 1.45,
  },
  quote: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.meta,
    lineHeight: FontSize.meta * 1.45,
    fontStyle: 'italic',
    paddingLeft: 11,
    borderLeftWidth: 2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 11,
    alignItems: 'flex-start',
  },
  checkbox: {
    width: 19,
    height: 19,
    marginTop: 1,
    borderRadius: Radius.check,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkGlyph: { color: '#ffffff', fontSize: 12, lineHeight: 14 },
  actionText: { flex: 1, gap: 6 },
  struck: { textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  metaChip: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: Radius.chip,
  },
  metaText: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.captionSmall,
  },
  pairRow: { flexDirection: 'row', gap: Space.md },
  pairCard: { flex: 1 },
  pairText: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.label,
    lineHeight: FontSize.label * 1.42,
  },
  soonChip: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
  },
  soonText: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.captionSmall,
  },
});
