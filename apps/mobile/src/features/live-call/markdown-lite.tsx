import { Fragment } from 'react';
import { StyleSheet, Text } from 'react-native';

/**
 * Markdown-lite for the copilot pane. The live prompt's format rules make the
 * model emit markdown (**bold** headlines, bullets) and TeX-style `$...$`
 * spans, but the pane renders plain RN Text — so the raw markers read as
 * garbage mid-call (Gustavo, 2026-07-23). This renders bold for real, strips
 * the markers that can't render, and is safe to run on PARTIAL streaming text
 * (an unclosed ** shows raw until its pair arrives, then upgrades). A full
 * markdown pass is Phase 8 polish.
 */

/** Normalize markers that RN Text can't render into readable plain text. */
export function cleanMarkers(raw: string): string {
  return (
    raw
      // \$ (the prompt's money escape) → literal $
      .replace(/\\\$/g, '$')
      // $...$ inline math → keep the content, drop the delimiters
      .replace(/\$([^$\n]+)\$/g, '$1')
      // markdown headers at line start → plain line
      .replace(/^#{1,6}\s+/gm, '')
      // `* item` bullets → `• item` (`- item` already reads fine)
      .replace(/^\*\s+/gm, '• ')
  );
}

export interface MarkdownSegment {
  readonly bold: boolean;
  readonly text: string;
}

/** Split on **bold** spans; anything unpaired stays literal (streaming-safe). */
export function toSegments(text: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const bold = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let match = bold.exec(text); match !== null; match = bold.exec(text)) {
    if (match.index > last) {
      segments.push({ bold: false, text: text.slice(last, match.index) });
    }
    segments.push({ bold: true, text: match[1] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ bold: false, text: text.slice(last) });
  }
  return segments;
}

/** Inline renderer — nest inside a ThemedText so theme color/size inherit. */
export function MarkdownLite({ text }: { text: string }) {
  const segments = toSegments(cleanMarkers(text));
  return (
    <>
      {segments.map((segment, index) =>
        segment.bold ? (
          <Text key={index} style={styles.bold}>
            {segment.text}
          </Text>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

const styles = StyleSheet.create({
  bold: {
    fontWeight: '600',
  },
});
