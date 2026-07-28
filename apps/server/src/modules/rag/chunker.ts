import type { ChunkConfig } from "./config.js";
import { RagError } from "./ports.js";
import type {
  Chunker,
  ChunkDraft,
  SourceMeta,
  TranscriptTurn,
} from "./ports.js";

/**
 * The pure, deterministic chunker (Phase 4). Zero I/O, zero clock — identical
 * input always yields byte-identical output. Two strategies share one estimator
 * and one contextual header:
 *
 * - transcripts pack consecutive diarized turns into ~`targetChunkTokens` windows
 *   (hard cap `maxChunkTokens`), never splitting inside a turn unless one turn
 *   alone overflows the cap, with one-turn overlap between windows;
 * - docs pack paragraphs to the same target/cap with ~`docOverlapRatio` overlap
 *   carried as trailing whole sentences.
 *
 * Design source: `docs/DECISIONS/adr-0005-rag-memory.md` §6.
 */

/**
 * Cheap, deterministic token estimate: ~4 chars/token (OpenAI/Voyage rule of
 * thumb). Exact token counts need the vendor tokenizer; for packing decisions
 * this is close enough and, crucially, has zero dependencies and never varies.
 */
export function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Render one turn as `"{speaker}: {text}"`, speaker falling back to "Speaker". */
function renderTurn(turn: TranscriptTurn): string {
  return `${turn.speaker ?? "Speaker"}: ${turn.text}`;
}

/** `Meeting: {title} ({date}) — {speakers}`, omitting absent parts gracefully. */
function buildMeetingHeader(meta: SourceMeta): string {
  let header = `Meeting: ${meta.title}`;
  if (meta.date !== undefined) header += ` (${meta.date})`;
  if (meta.speakers && meta.speakers.length > 0) {
    header += ` — ${meta.speakers.join(", ")}`;
  }
  return header;
}

/** Split on sentence-ending punctuation followed by whitespace; drop blanks. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Greedily pack sentences into windows of `sentence` arrays: close a window once
 * it reaches the soft target, or before adding a sentence would breach the cap.
 * A lone sentence above the cap becomes its own (over-cap) window — there is no
 * smaller boundary to split on.
 */
function packSentenceWindows(text: string, cfg: ChunkConfig): string[][] {
  const sentences = splitSentences(text);
  const windows: string[][] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const flush = (): void => {
    if (cur.length > 0) {
      windows.push(cur);
      cur = [];
      curTokens = 0;
    }
  };
  for (const sentence of sentences) {
    const tok = approxTokens(sentence);
    if (cur.length > 0 && curTokens + tok > cfg.maxChunkTokens) flush();
    cur.push(sentence);
    curTokens += tok;
    if (curTokens >= cfg.targetChunkTokens) flush();
  }
  flush();
  return windows;
}

/**
 * Trailing whole sentences of a window covering ~`docOverlapRatio` of its tokens
 * — the doc/oversized overlap unit. Preserves source order.
 */
function overlapSentences(sentences: string[], cfg: ChunkConfig): string[] {
  const need = Math.ceil(
    approxTokens(sentences.join(" ")) * cfg.docOverlapRatio,
  );
  if (need <= 0) return [];
  const picked: string[] = [];
  let acc = 0;
  for (const sentence of [...sentences].reverse()) {
    picked.unshift(sentence);
    acc += approxTokens(sentence);
    if (acc >= need) break;
  }
  return picked;
}

/**
 * Split one over-cap turn on sentence boundaries (with the doc overlap rule),
 * re-prefixing every piece with the speaker so each chunk stays self-describing.
 */
function splitOversizedTurn(turn: TranscriptTurn, cfg: ChunkConfig): string[] {
  const speaker = turn.speaker ?? "Speaker";
  const windows = packSentenceWindows(turn.text, cfg);
  const out: string[] = [];
  let prev: string[] | null = null;
  for (const window of windows) {
    const overlap = prev ? overlapSentences(prev, cfg) : [];
    const body = (overlap.length > 0 ? overlap.concat(window) : window).join(
      " ",
    );
    out.push(`${speaker}: ${body}`);
    prev = window;
  }
  return out;
}

/** A contiguous run of turns that fit together, or one over-cap turn to split. */
type TurnGroup =
  | { readonly kind: "turns"; readonly lines: string[] }
  | { readonly kind: "oversized"; readonly turn: TranscriptTurn };

/** Partition turns into contiguous, non-overlapping groups honoring the cap. */
function partitionTurns(
  turns: TranscriptTurn[],
  cfg: ChunkConfig,
): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const flush = (): void => {
    if (cur.length > 0) {
      groups.push({ kind: "turns", lines: cur });
      cur = [];
      curTokens = 0;
    }
  };
  for (const turn of turns) {
    const line = renderTurn(turn);
    const tok = approxTokens(line);
    if (tok > cfg.maxChunkTokens) {
      flush();
      groups.push({ kind: "oversized", turn });
      continue;
    }
    if (cur.length > 0 && curTokens + tok > cfg.maxChunkTokens) flush();
    cur.push(line);
    curTokens += tok;
    if (curTokens >= cfg.targetChunkTokens) flush();
  }
  flush();
  return groups;
}

/** Turn packed window contents into finished drafts, guarding the source cap. */
function finalize(
  header: string,
  contents: string[],
  cfg: ChunkConfig,
): ChunkDraft[] {
  if (contents.length > cfg.maxChunksPerSource) {
    throw RagError.sourceTooLarge(
      `source produced ${String(contents.length)} chunks, exceeding maxChunksPerSource=${String(cfg.maxChunksPerSource)}`,
    );
  }
  return contents.map((content, chunkIndex) => ({
    content,
    header,
    chunkIndex,
    tokenCount: approxTokens(`${header} ${content}`),
  }));
}

function chunkTranscript(
  turns: TranscriptTurn[],
  meta: SourceMeta,
  cfg: ChunkConfig,
): ChunkDraft[] {
  const header = buildMeetingHeader(meta);
  const kept = turns.filter((t) => t.text.trim() !== "");
  const groups = partitionTurns(kept, cfg);
  const contents: string[] = [];
  // `prevLast` is the previous window's last turn — prepended to the next window
  // so consecutive windows overlap by exactly one turn. An oversized turn's
  // sentence-split pieces break that chain (there is no single turn to carry).
  let prevLast: string | null = null;
  for (const group of groups) {
    if (group.kind === "oversized") {
      for (const piece of splitOversizedTurn(group.turn, cfg)) {
        contents.push(piece);
      }
      prevLast = null;
      continue;
    }
    const windowLines =
      prevLast !== null ? [prevLast, ...group.lines] : [...group.lines];
    contents.push(windowLines.join("\n"));
    prevLast = group.lines[group.lines.length - 1] ?? null;
  }
  return finalize(header, contents, cfg);
}

function chunkDoc(
  content: string,
  meta: SourceMeta,
  cfg: ChunkConfig,
): ChunkDraft[] {
  const header = `Doc: ${meta.title}`;
  const paragraphs = content
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (paragraphs.length === 0) return [];

  // Pass 1: pack paragraphs into fresh (overlap-free) window bodies, expanding
  // any single over-cap paragraph into sentence windows.
  const bodies: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const flush = (): void => {
    if (cur.length > 0) {
      bodies.push(cur.join("\n\n"));
      cur = [];
      curTokens = 0;
    }
  };
  for (const paragraph of paragraphs) {
    const tok = approxTokens(paragraph);
    if (tok > cfg.maxChunkTokens) {
      flush();
      for (const window of packSentenceWindows(paragraph, cfg)) {
        bodies.push(window.join(" "));
      }
      continue;
    }
    if (cur.length > 0 && curTokens + tok > cfg.maxChunkTokens) flush();
    cur.push(paragraph);
    curTokens += tok;
    if (curTokens >= cfg.targetChunkTokens) flush();
  }
  flush();

  // Pass 2: prepend each window with the previous window's trailing sentences.
  const contents: string[] = [];
  let prevSentences: string[] | null = null;
  for (const body of bodies) {
    const overlap = prevSentences ? overlapSentences(prevSentences, cfg) : [];
    contents.push(
      overlap.length > 0 ? `${overlap.join(" ")}\n\n${body}` : body,
    );
    prevSentences = splitSentences(body);
  }
  return finalize(header, contents, cfg);
}

/** The {@link Chunker} port binding. */
export const chunker: Chunker = { chunkTranscript, chunkDoc };
