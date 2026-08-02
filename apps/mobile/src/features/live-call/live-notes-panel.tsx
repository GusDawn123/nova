import { StyleSheet, Text, View } from 'react-native';

import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  eyebrowStyle,
  type Palette,
} from '@/design/tokens';
import type { LiveNotesState } from '@/features/notes/notes-update';

/**
 * Live notes DURING the call (`docs/DESIGN/notes-ui.md` §5.1), in the redesign's
 * idiom (`docs/superpowers/specs/2026-08-02-nova-ui-design.md` §5).
 *
 * Condensed on purpose. This is a preview someone glances at mid-sentence, so it
 * carries the tl;dr, what was decided, and what they now owe — and drops the
 * post-call document's structure (overview, risks table, insights).
 *
 * Read-only, with NO checkboxes. Completion is keyed to the FINAL notes' item ids;
 * a checkbox here would invite a tap that the next fold could quietly move onto a
 * different item, which is worse than not offering one.
 *
 * It lives INSIDE the capture pane's ink-washed card, so its own sections are
 * hairline-bordered rather than washed again — a fill on a fill is invisible.
 */
export function LiveNotesPanel({
  state,
  palette,
}: {
  state: LiveNotesState;
  palette: Palette;
}): React.JSX.Element {
  const notes = state.notes;

  if (notes === null) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.line, { color: palette.inkFaint }]}>
          Notes start filling in once there is something worth writing down.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Section palette={palette} eyebrow="TL;DR">
        <Text style={[styles.tldr, { color: palette.ink }]}>{notes.tldr}</Text>
      </Section>

      {notes.decisions.length > 0 ? (
        <Section palette={palette} eyebrow="DECIDED">
          {notes.decisions.map((decision) => (
            <Text
              key={decision.id}
              style={[styles.line, { color: palette.inkSoft }]}
            >
              {decision.text}
            </Text>
          ))}
        </Section>
      ) : null}

      {notes.actionItems.length > 0 ? (
        <Section palette={palette} eyebrow="ACTION ITEMS">
          {notes.actionItems.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <Text style={[styles.line, { color: palette.inkSoft }]}>
                {item.text}
              </Text>
              <View style={styles.chips}>
                {item.owner !== null ? (
                  <Chip palette={palette} filled>
                    {item.owner}
                  </Chip>
                ) : null}
                {/* deadlineRaw is the phrase someone actually said ("Thursday").
                    The ISO `deadline` is for machines; showing it would replace
                    what was said with a date we inferred. */}
                {item.deadlineRaw !== null ? (
                  <Chip palette={palette}>{item.deadlineRaw}</Chip>
                ) : null}
              </View>
            </View>
          ))}
        </Section>
      ) : null}

      {notes.openQuestions.length > 0 ? (
        <Section palette={palette} eyebrow="OPEN">
          {notes.openQuestions.map((question) => (
            <Text
              key={question.id}
              style={[styles.line, { color: palette.inkSoft }]}
            >
              {question.text}
            </Text>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

function Section({
  palette,
  eyebrow,
  children,
}: {
  palette: Palette;
  eyebrow: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.section, { borderColor: palette.inkHairline }]}>
      <Text style={[styles.eyebrow, { color: palette.inkFaint }]}>{eyebrow}</Text>
      {children}
    </View>
  );
}

/** An owner or a deadline. Filled marks the owner — the part that names a person. */
function Chip({
  palette,
  filled = false,
  children,
}: {
  palette: Palette;
  filled?: boolean;
  children: string;
}): React.JSX.Element {
  return (
    <Text
      style={[
        styles.chip,
        filled
          ? { color: palette.onInk, backgroundColor: palette.ink }
          : { color: palette.inkSoft, borderColor: palette.inkHairline },
        filled ? undefined : styles.chipOutline,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { gap: Space.sm2 },
  section: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.soft,
    padding: Space.md,
    gap: Space.xs2,
  },
  empty: { paddingVertical: Space.lg },
  eyebrow: eyebrowStyle,
  tldr: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.45,
  },
  line: {
    fontFamily: FontFamily.body,
    fontSize: FontSize.bodyXs,
    lineHeight: FontSize.bodyXs * 1.45,
  },
  itemRow: { gap: Space.xs2 },
  chips: { flexDirection: 'row', gap: Space.xs2, flexWrap: 'wrap' },
  chip: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.monoXs,
    paddingVertical: Space.xs,
    paddingHorizontal: Space.sm2,
    borderRadius: Radius.chip,
    overflow: 'hidden',
  },
  chipOutline: { borderWidth: StyleSheet.hairlineWidth },
});
