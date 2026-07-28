import { describe, expect, it } from "vitest";

import {
  RagError,
  chunkDraftSchema,
  isRagError,
  ragHitSchema,
  ragSourceSchema,
  sourceMetaSchema,
  transcriptTurnSchema,
} from "./ports.js";

describe("RagError", () => {
  it("is an Error carrying a typed code and stable name", () => {
    const err = new RagError("SOURCE_TOO_LARGE", "too many chunks");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RagError);
    expect(err.code).toBe("SOURCE_TOO_LARGE");
    expect(err.name).toBe("RagError");
    expect(err.message).toBe("too many chunks");
  });

  it("threads a cause without inventing one when absent", () => {
    const cause = new Error("root");
    expect(new RagError("STORE_FAILED", "boom", { cause }).cause).toBe(cause);
    expect(new RagError("EMBEDDER_FAILED", "boom").cause).toBeUndefined();
  });

  it("exposes every taxonomy code via the constructor", () => {
    for (const code of [
      "RAG_NOT_CONFIGURED",
      "EMBEDDER_FAILED",
      "STORE_FAILED",
      "SOURCE_TOO_LARGE",
    ] as const) {
      expect(new RagError(code).code).toBe(code);
    }
  });

  it("narrows unknown values with isRagError", () => {
    expect(isRagError(new RagError("RAG_NOT_CONFIGURED"))).toBe(true);
    expect(isRagError(new Error("plain"))).toBe(false);
    expect(isRagError("nope")).toBe(false);
  });
});

describe("ragSourceSchema", () => {
  it("parses a context-doc source", () => {
    expect(
      ragSourceSchema.parse({ kind: "context_doc", contextDocId: "doc-1" }),
    ).toEqual({ kind: "context_doc", contextDocId: "doc-1" });
  });

  it("parses a meeting source", () => {
    expect(
      ragSourceSchema.parse({ kind: "meeting", meetingId: "mtg-1" }),
    ).toEqual({ kind: "meeting", meetingId: "mtg-1" });
  });

  it("rejects an unknown kind", () => {
    expect(ragSourceSchema.safeParse({ kind: "email", id: "x" }).success).toBe(
      false,
    );
  });

  it("rejects a source missing its parent id", () => {
    expect(ragSourceSchema.safeParse({ kind: "context_doc" }).success).toBe(
      false,
    );
    expect(ragSourceSchema.safeParse({ kind: "meeting" }).success).toBe(false);
  });
});

describe("ragHitSchema", () => {
  it("parses a hit with a doc parent and a null meeting parent", () => {
    const hit = ragHitSchema.parse({
      chunkId: "c-1",
      content: "hello",
      header: "Doc: X",
      score: 0.42,
      contextDocId: "doc-1",
      meetingId: null,
    });
    expect(hit.contextDocId).toBe("doc-1");
    expect(hit.meetingId).toBeNull();
  });

  it("requires the source-ref fields to be present (nullable, not optional)", () => {
    expect(
      ragHitSchema.safeParse({
        chunkId: "c-1",
        content: "hello",
        header: "Doc: X",
        score: 0.42,
      }).success,
    ).toBe(false);
  });
});

describe("transcriptTurnSchema", () => {
  it("accepts null speaker and null tsMs", () => {
    expect(
      transcriptTurnSchema.parse({ speaker: null, text: "hi", tsMs: null }),
    ).toEqual({ speaker: null, text: "hi", tsMs: null });
  });

  it("requires text", () => {
    expect(
      transcriptTurnSchema.safeParse({ speaker: "A", tsMs: 0 }).success,
    ).toBe(false);
  });
});

describe("sourceMetaSchema", () => {
  it("requires a title and leaves date/speakers optional", () => {
    expect(sourceMetaSchema.parse({ title: "Sync" })).toEqual({
      title: "Sync",
    });
    const full = sourceMetaSchema.parse({
      title: "Sync",
      date: "2026-07-20",
      speakers: ["Alice", "Bob"],
    });
    expect(full.date).toBe("2026-07-20");
    expect(full.speakers).toEqual(["Alice", "Bob"]);
  });

  it("rejects a meta without a title", () => {
    expect(sourceMetaSchema.safeParse({ date: "2026-07-20" }).success).toBe(
      false,
    );
  });
});

describe("chunkDraftSchema", () => {
  it("parses a well-formed draft", () => {
    const draft = chunkDraftSchema.parse({
      content: "body",
      header: "Doc: X",
      chunkIndex: 0,
      tokenCount: 3,
    });
    expect(draft.chunkIndex).toBe(0);
  });

  it("rejects a negative chunk index", () => {
    expect(
      chunkDraftSchema.safeParse({
        content: "body",
        header: "Doc: X",
        chunkIndex: -1,
        tokenCount: 3,
      }).success,
    ).toBe(false);
  });
});
