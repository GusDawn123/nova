import { describe, expect, it } from "vitest";

import { approxTokens, chunker } from "./chunker.js";
import type { ChunkConfig } from "./config.js";
import { RagError } from "./ports.js";
import type { SourceMeta, TranscriptTurn } from "./ports.js";

/**
 * Small deterministic config: a 20-token hard cap (= 80 chars) and a 10-token
 * soft target keep the fixtures tiny while still exercising multi-window packing,
 * overlap, and the oversized-unit split paths.
 */
const cfg: ChunkConfig = {
  targetChunkTokens: 10,
  maxChunkTokens: 20,
  docOverlapRatio: 0.15,
  maxChunksPerSource: 2000,
};

const render = (speaker: string | null, text: string): string =>
  `${speaker ?? "Speaker"}: ${text}`;

const turn = (speaker: string | null, text: string): TranscriptTurn => ({
  speaker,
  text,
  tsMs: null,
});

const lines = (content: string): string[] => content.split("\n");

describe("approxTokens", () => {
  it("is ceil(length / 4)", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
    expect(approxTokens("a".repeat(400))).toBe(100);
  });
});

describe("chunkTranscript — headers", () => {
  const one = [turn("Alice", "hi there")];

  it("renders the full meeting header", () => {
    const meta: SourceMeta = {
      title: "Sync",
      date: "2026-07-20",
      speakers: ["Alice", "Bob"],
    };
    expect(chunker.chunkTranscript(one, meta, cfg)[0]?.header).toBe(
      "Meeting: Sync (2026-07-20) — Alice, Bob",
    );
  });

  it("omits the date gracefully", () => {
    const meta: SourceMeta = { title: "Sync", speakers: ["Alice"] };
    expect(chunker.chunkTranscript(one, meta, cfg)[0]?.header).toBe(
      "Meeting: Sync — Alice",
    );
  });

  it("omits the speakers gracefully", () => {
    const meta: SourceMeta = { title: "Sync", date: "2026-07-20" };
    expect(chunker.chunkTranscript(one, meta, cfg)[0]?.header).toBe(
      "Meeting: Sync (2026-07-20)",
    );
  });

  it("renders a bare title-only header", () => {
    expect(chunker.chunkTranscript(one, { title: "Sync" }, cfg)[0]?.header).toBe(
      "Meeting: Sync",
    );
  });
});

describe("chunkTranscript — packing & overlap", () => {
  const meta: SourceMeta = { title: "Sync" };
  const turns: TranscriptTurn[] = Array.from({ length: 6 }, (_v, i) =>
    turn("Alice", `msg ${String(i)} alpha beta gamma`),
  );

  it("packs consecutive turns into overlapping windows", () => {
    const chunks = chunker.chunkTranscript(turns, meta, cfg);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  it("overlaps each window with the previous window's last turn", () => {
    const chunks = chunker.chunkTranscript(turns, meta, cfg);
    for (let i = 1; i < chunks.length; i += 1) {
      const prevChunk = chunks[i - 1];
      const curChunk = chunks[i];
      if (!prevChunk || !curChunk) throw new Error("unreachable");
      const prev = lines(prevChunk.content);
      const cur = lines(curChunk.content);
      expect(cur[0]).toBe(prev.at(-1));
    }
  });

  it("renders a null speaker as \"Speaker\"", () => {
    const chunks = chunker.chunkTranscript([turn(null, "solo")], meta, cfg);
    expect(chunks[0]?.content).toBe(render(null, "solo"));
    expect(chunks[0]?.content).toBe("Speaker: solo");
  });

  it("sets tokenCount to approxTokens(header + ' ' + content)", () => {
    for (const c of chunker.chunkTranscript(turns, meta, cfg)) {
      expect(c.tokenCount).toBe(approxTokens(`${c.header} ${c.content}`));
    }
  });

  it("is deterministic — identical output across runs", () => {
    expect(chunker.chunkTranscript(turns, meta, cfg)).toEqual(
      chunker.chunkTranscript(turns, meta, cfg),
    );
  });
});

describe("chunkTranscript — edge cases", () => {
  const meta: SourceMeta = { title: "Sync" };

  it("returns [] for no turns", () => {
    expect(chunker.chunkTranscript([], meta, cfg)).toEqual([]);
  });

  it("skips whitespace-only turns and returns [] when all are blank", () => {
    expect(
      chunker.chunkTranscript(
        [turn("Alice", "   "), turn("Bob", "\t\n ")],
        meta,
        cfg,
      ),
    ).toEqual([]);
  });

  it("keeps a turn rendered exactly at the cap in a single chunk", () => {
    const text = "a".repeat(77); // "S: " (3) + 77 = 80 chars = exactly 20 tokens
    const chunks = chunker.chunkTranscript([turn("S", text)], meta, cfg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(`S: ${text}`);
    expect(approxTokens(`S: ${text}`)).toBe(cfg.maxChunkTokens);
  });

  it("splits a single turn that overflows the cap on sentence boundaries", () => {
    const text =
      "Alpha beta gamma. Delta epsilon zeta. Eta theta iota. " +
      "Kappa lambda mu. Nu xi omicron.";
    const chunks = chunker.chunkTranscript([turn("S", text)], meta, cfg);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.content.startsWith("S: ")).toBe(true);
    }
    const joined = chunks.map((c) => c.content).join(" ");
    for (const word of ["Alpha", "Delta", "Eta", "Kappa", "Nu"]) {
      expect(joined).toContain(word);
    }
  });

  it("handles unicode without throwing and preserves the text", () => {
    const chunks = chunker.chunkTranscript(
      [turn("Renée", "café ☕ déjà vu — 你好 🌍")],
      meta,
      cfg,
    );
    expect(chunks[0]?.content).toBe("Renée: café ☕ déjà vu — 你好 🌍");
  });

  it("throws RagError(SOURCE_TOO_LARGE) past the per-source cap", () => {
    const tiny: ChunkConfig = { ...cfg, targetChunkTokens: 1, maxChunksPerSource: 2 };
    const turns = Array.from({ length: 5 }, (_v, i) =>
      turn("Alice", `turn number ${String(i)} here`),
    );
    let thrown: unknown;
    try {
      chunker.chunkTranscript(turns, meta, tiny);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RagError);
    expect((thrown as RagError).code).toBe("SOURCE_TOO_LARGE");
  });
});

describe("chunkDoc", () => {
  const meta: SourceMeta = { title: "Handbook" };

  it("renders the doc header", () => {
    const chunks = chunker.chunkDoc("Hello world.", meta, cfg);
    expect(chunks[0]?.header).toBe("Doc: Handbook");
  });

  it("returns [] for empty or whitespace-only content", () => {
    expect(chunker.chunkDoc("", meta, cfg)).toEqual([]);
    expect(chunker.chunkDoc("   \n\n  \t ", meta, cfg)).toEqual([]);
  });

  it("packs paragraphs and overlaps with trailing whole sentences", () => {
    const content =
      "Alpha sentence one.\n\nBravo sentence two.\n\n" +
      "Charlie sentence three.\n\nDelta sentence four.";
    const chunks = chunker.chunkDoc(content, meta, cfg);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.content).toBe(
      "Alpha sentence one.\n\nBravo sentence two.",
    );
    expect(chunks[1]?.content.startsWith("Bravo sentence two.")).toBe(true);
  });

  it("assigns sequential chunk indices from 0", () => {
    const content =
      "Alpha sentence one.\n\nBravo sentence two.\n\n" +
      "Charlie sentence three.\n\nDelta sentence four.";
    const chunks = chunker.chunkDoc(content, meta, cfg);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(
      chunks.map((_c, i) => i),
    );
  });

  it("sets tokenCount to approxTokens(header + ' ' + content)", () => {
    const content =
      "Alpha sentence one.\n\nBravo sentence two.\n\nCharlie sentence three.";
    for (const c of chunker.chunkDoc(content, meta, cfg)) {
      expect(c.tokenCount).toBe(approxTokens(`${c.header} ${c.content}`));
    }
  });

  it("splits a paragraph that overflows the cap on sentence boundaries", () => {
    const para =
      "Alpha beta gamma delta. Epsilon zeta eta theta. " +
      "Iota kappa lambda mu. Nu xi omicron pi.";
    const chunks = chunker.chunkDoc(para, meta, cfg);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const joined = chunks.map((c) => c.content).join(" ");
    for (const word of ["Alpha", "Epsilon", "Iota", "Nu"]) {
      expect(joined).toContain(word);
    }
  });

  it("is deterministic — identical output across runs", () => {
    const content =
      "Alpha sentence one.\n\nBravo sentence two.\n\nCharlie sentence three.";
    expect(chunker.chunkDoc(content, meta, cfg)).toEqual(
      chunker.chunkDoc(content, meta, cfg),
    );
  });

  it("throws RagError(SOURCE_TOO_LARGE) past the per-source cap", () => {
    const tiny: ChunkConfig = { ...cfg, targetChunkTokens: 1, maxChunksPerSource: 2 };
    const content =
      "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.";
    let thrown: unknown;
    try {
      chunker.chunkDoc(content, meta, tiny);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RagError);
    expect((thrown as RagError).code).toBe("SOURCE_TOO_LARGE");
  });
});
