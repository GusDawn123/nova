import { describe, expect, it } from "vitest";

import { chunkTurns } from "./chunking.js";
import { notesConfigSchema } from "./config.js";
import type { TranscriptTurn } from "./ports.js";
import { CHARS_PER_TOKEN, estimateTokens } from "./tokens.js";

/**
 * Chunking is pure + deterministic — no DB, no clock. These cover the boundary
 * cases the brief calls out: empty, one giant turn, exact-fit, overlap carryover,
 * plus the never-split-a-turn invariant across a multi-chunk transcript.
 */

/** A turn whose text estimates to ~`tokens` tokens (padding to the chars/token rate). */
function turnOf(tokens: number, speaker = "spk_0", tsMs = 0): TranscriptTurn {
  return { speaker, text: "x".repeat(tokens * CHARS_PER_TOKEN), tsMs };
}

/** Chunk options with an explicit budget + overlap (defaults filled by the schema). */
function opts(mapChunkTokens: number, mapOverlapRatio: number) {
  const cfg = notesConfigSchema.parse({ mapChunkTokens, mapOverlapRatio });
  return { mapChunkTokens: cfg.mapChunkTokens, mapOverlapRatio: cfg.mapOverlapRatio };
}

describe("chunkTurns", () => {
  it("returns no chunks for an empty transcript", () => {
    expect(chunkTurns([], opts(100, 0.15))).toEqual([]);
  });

  it("keeps a small transcript in a single chunk", () => {
    const turns = [turnOf(10), turnOf(10), turnOf(10)];
    const chunks = chunkTurns(turns, opts(100, 0.15));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.turns).toHaveLength(3);
    expect(chunks[0]?.index).toBe(0);
  });

  it("emits an oversized single turn as its own chunk (never split)", () => {
    const giant = turnOf(250); // > the 100-token budget
    const chunks = chunkTurns([giant], opts(100, 0.15));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.turns).toEqual([giant]);
    expect(estimateTokens(chunks[0]?.turns[0]?.text ?? "")).toBeGreaterThan(100);
  });

  it("isolates a giant turn in the middle and flushes the open chunk first", () => {
    const a = turnOf(30, "spk_0", 0);
    const b = turnOf(30, "spk_1", 1000);
    const giant = turnOf(250, "spk_0", 2000);
    const c = turnOf(30, "spk_1", 3000);
    const chunks = chunkTurns([a, b, giant, c], opts(100, 0.15));
    // [a,b] | [giant] | [c] — the giant never merges with its neighbours.
    expect(chunks.map((k) => k.turns)).toEqual([[a, b], [giant], [c]]);
  });

  it("packs an exact-fit boundary without overflowing (== budget is allowed)", () => {
    // Four 25-token turns exactly fill a 100-token budget → one chunk, no split.
    const turns = [turnOf(25), turnOf(25), turnOf(25), turnOf(25)];
    const chunks = chunkTurns(turns, opts(100, 0.15));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.turns).toHaveLength(4);
  });

  it("splits into multiple chunks and carries overlap turns across the seam", () => {
    // Budget 100, overlap 15 tokens (0.15). Six 30-token turns: 3 fit (90) then
    // the 4th overflows → new chunk. The overlap tail seeds the 3rd turn (30 > 15?)
    // — so with 30-token turns nothing fits the 15-token overlap budget; use
    // 10-token turns to prove real carryover.
    const turns = Array.from({ length: 24 }, (_, i) => turnOf(10, `spk_${String(i % 2)}`, i * 1000));
    const chunks = chunkTurns(turns, opts(100, 0.2)); // overlap budget = 20 tokens = 2 turns
    expect(chunks.length).toBeGreaterThan(1);

    // The last turn of chunk N reappears as an early turn of chunk N+1 (overlap).
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const prev = chunks[i]?.turns ?? [];
      const next = chunks[i + 1]?.turns ?? [];
      const prevTail = prev[prev.length - 1];
      expect(next).toContainEqual(prevTail);
    }
  });

  it("never splits a turn: every input turn appears whole, in order, at least once", () => {
    const turns = Array.from({ length: 40 }, (_, i) => turnOf(12, `spk_${String(i % 2)}`, i * 1000));
    const chunks = chunkTurns(turns, opts(100, 0.15));

    // Concatenate chunk turns dropping overlap repeats: the de-duplicated,
    // order-preserving union must equal the original transcript exactly.
    const seen: TranscriptTurn[] = [];
    for (const chunk of chunks) {
      for (const turn of chunk.turns) {
        if (!seen.includes(turn)) seen.push(turn);
      }
    }
    expect(seen).toEqual(turns);
  });

  it("is deterministic for identical input", () => {
    const turns = Array.from({ length: 30 }, (_, i) => turnOf(15, `spk_${String(i % 2)}`, i * 1000));
    const a = chunkTurns(turns, opts(100, 0.15));
    const b = chunkTurns(turns, opts(100, 0.15));
    expect(a).toEqual(b);
  });
});
