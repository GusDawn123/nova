import type { NotesConfig } from "./config.js";
import type { TranscriptTurn } from "./ports.js";
import { estimateTokens } from "./tokens.js";

/**
 * Turn-boundary token-budget packing for the map step (adr-0006 §5; DESIGN
 * §generation-decisions). The map-reduce path splits an over-budget transcript
 * into chunks that are:
 *
 *   - cut ONLY at speaker-turn boundaries — a turn is never split across chunks,
 *     so a diarized utterance (and its owner/quote) always lands whole in exactly
 *     one map call. An oversized SINGLE turn (rare — a monologue longer than the
 *     budget) becomes its own chunk rather than being truncated or split.
 *   - ≤ `mapChunkTokens` where possible (a lone oversized turn is the only way a
 *     chunk exceeds it), sized with the shared chars/token estimator (no tokenizer).
 *   - overlapped ~`mapOverlapRatio` (15%) with the previous chunk: each new chunk
 *     is seeded with the tail turns of the one before it (whole turns, up to the
 *     overlap token budget), so a fact spoken across a boundary is seen by both
 *     map calls and cannot be lost at the seam.
 *
 * Pure + deterministic (no clock, no randomness): the same turns + config always
 * produce the same chunks.
 */

/** One map-step chunk: a contiguous (possibly overlap-seeded) run of whole turns. */
export interface NotesChunk {
  /** 0-based position in the emitted sequence (ordered, gap-free). */
  readonly index: number;
  /** The turns packed into this chunk, in transcript order. */
  readonly turns: TranscriptTurn[];
}

/** The chunking knobs the map step reads from {@link NotesConfig}. */
export type ChunkOptions = Pick<
  NotesConfig,
  "mapChunkTokens" | "mapOverlapRatio"
>;

/** Estimate one turn's token cost (text only — the heuristic; adr-0006 §5). */
function turnTokens(turn: TranscriptTurn): number {
  return estimateTokens(turn.text);
}

/**
 * The trailing turns of a just-closed chunk whose cumulative token cost stays
 * within `budget`, returned in transcript order — the overlap seed for the next
 * chunk. A `budget` of 0 (or a chunk whose last turn already exceeds it) yields
 * an empty seed.
 */
function overlapTail(
  turns: TranscriptTurn[],
  budget: number,
): TranscriptTurn[] {
  if (budget <= 0) return [];
  const seed: TranscriptTurn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const cost = turnTokens(turn);
    if (total + cost > budget) break;
    total += cost;
    seed.unshift(turn);
  }
  return seed;
}

/**
 * Pack `turns` into overlapping, turn-boundary chunks (see the file header).
 * `mapChunkTokens` is the soft ceiling; `mapOverlapRatio × mapChunkTokens` is the
 * per-seam overlap budget. Returns `[]` for an empty transcript.
 */
export function chunkTurns(
  turns: TranscriptTurn[],
  options: ChunkOptions,
): NotesChunk[] {
  const maxTokens = options.mapChunkTokens;
  const overlapBudget = Math.floor(maxTokens * options.mapOverlapRatio);

  const chunks: TranscriptTurn[][] = [];
  let current: TranscriptTurn[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
    }
  };

  for (const turn of turns) {
    const cost = turnTokens(turn);

    // An oversized single turn stands alone: close whatever is open (no overlap
    // seeding across a giant), emit it as its own chunk, and reset. Seeding an
    // overlap from a giant is pointless — it can never fit the overlap budget.
    if (cost > maxTokens) {
      flush();
      chunks.push([turn]);
      current = [];
      currentTokens = 0;
      continue;
    }

    // Adding this turn would overflow the open chunk → close it and start a fresh
    // one seeded with the overlap tail, then place the turn into the new chunk.
    if (current.length > 0 && currentTokens + cost > maxTokens) {
      flush();
      const seed = overlapTail(current, overlapBudget);
      current = [...seed];
      currentTokens = seed.reduce((sum, t) => sum + turnTokens(t), 0);
    }

    current.push(turn);
    currentTokens += cost;
  }
  flush();

  return chunks.map((chunkTurnsList, index) => ({
    index,
    turns: chunkTurnsList,
  }));
}
