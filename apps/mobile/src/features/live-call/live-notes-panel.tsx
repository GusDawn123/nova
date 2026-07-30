import { StyleSheet, Text, View } from 'react-native';

import { GlassSurface } from '@/design/glass';
import {
  FontFamily,
  FontSize,
  Radius,
  Space,
  type Palette,
} from '@/design/tokens';
import type { LiveNotesState } from '@/features/notes/notes-update';

/**
 * Live notes DURING the call (`docs/DESIGN/notes-ui.md` §5.1).
 *
 * Condensed on purpose. This is a preview someone glances at mid-sentence, so it
 * carries the tl;dr, what was decided, and what they now owe — and drops the
 * post-call document's structure (overview, risks table, insights).
 *
 * Read-only, with NO checkboxes. Completion is keyed to the FINAL notes' item ids;
 * a checkbox here would invite a tap that the next fold could quietly move onto a
 * different item, which is worse than not offering one.
 *
 * The design prototype has no live-notes surface at all — its capture card is
 * transcript-only. This is §5.1's ruling built in the prototype's card idiom.
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
        <Text style={[styles.emptyText, { color: palette.ink3 }]}>
          Notes start filling in once there is something worth writing down.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <GlassSurface palette={palette} style={styles.card} elevated>
        <Eyebrow palette={palette}>tl;dr</Eyebrow>
        <Text style={[styles.tldr, { color: palette.ink }]}>{notes.tldr}</Text>
      </GlassSurface>

      {notes.decisions.length > 0 ? (
        <GlassSurface palette={palette} style={styles.card}>
          <Eyebrow palette={palette}>decided</Eyebrow>
          {notes.decisions.map((decision) => (
            <Text
              key={decision.id}
              style={[styles.line, { color: palette.ink2 }]}
            >
              {decision.text}
            </Text>
          ))}
        </GlassSurface>
      ) : null}

      {notes.actionItems.length > 0 ? (
        <GlassSurface palette={palette} style={styles.card}>
          <Eyebrow palette={palette}>action items</Eyebrow>
          {notes.actionItems.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <Text style={[styles.line, { color: palette.ink2 }]}>
                {item.text}
              </Text>
              <View style={styles.chips}>
                {item.owner !== null ? (
                  <Chip palette={palette} accent>
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
        </GlassSurface>
      ) : null}

      {notes.openQuestions.length > 0 ? (
        <GlassSurface palette={palette} style={styles.card}>
          <Eyebrow palette={palette}>open</Eyebrow>
          {notes.openQuestions.map((q) => (
            <Text key={q.id} style={[styles.line, { color: palette.ink2 }]}>
              {q.text}
            </Text>
          ))}
        </GlassSurface>
      ) : null}
    </View>
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

function Chip({
  palette,
  accent = false,
  children,
}: {
  palette: Palette;
  accent?: boolean;
  children: string;
}): React.JSX.Element {
  return (
    <Text
      style={[
        styles.chip,
        {
          color: accent ? palette.ink : palette.ink2,
          backgroundColor: accent ? palette.accentFill : palette.glass,
          borderColor: accent ? 'transparent' : palette.stroke,
        },
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { gap: Space.sm },
  card: { padding: Space.md, gap: 8 },
  empty: { paddingVertical: Space.lg, paddingHorizontal: Space.sm },
  emptyText: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.labelSmall,
    lineHeight: FontSize.labelSmall * 1.5,
  },
  eyebrow: {
    fontFamily: FontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  tldr: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.label,
    lineHeight: FontSize.label * 1.45,
  },
  line: {
    fontFamily: FontFamily.sans,
    fontSize: FontSize.labelSmall,
    lineHeight: FontSize.labelSmall * 1.42,
  },
  itemRow: { gap: 6 },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    fontFamily: FontFamily.sans,
    fontSize: 11,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: Radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
