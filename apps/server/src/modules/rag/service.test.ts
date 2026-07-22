import { describe, expect, it } from "vitest";

import { approxTokens } from "./chunker.js";
import { chunker } from "./chunker.js";
import { ragConfig, type RagConfig } from "./config.js";
import { isRagError } from "./ports.js";
import type { RagHit } from "./ports.js";
import { createRagService, type RagServiceDeps } from "./service.js";
import { MockEmbedder, MockStore, SpyReranker, makeHit } from "./testing/mock-rag.js";

/**
 * RagService behavior suite — pure, deterministic, mock-driven (no network, DB, or
 * clock). It proves the orchestration contract: the tier-gated reranker law (live
 * NEVER reranks — adr-0005 §5), the token-budget trim (retrieval shrinks, never
 * delays — adr §8), empty-corpus graceful return, idempotent ingest delegation,
 * and typed-error propagation. The keyless RAG_NOT_CONFIGURED posture lives in
 * index.test.ts (the module factory); the top-3 accuracy gate in rag.accuracy.test.ts.
 */

const USER = "user-a";

/** A service over fresh mock ports; returns the doubles so tests can inspect them. */
function build(
  over: Partial<RagServiceDeps> & { hits?: RagHit[] } = {},
): {
  embedder: MockEmbedder;
  store: MockStore;
  reranker: SpyReranker;
  service: ReturnType<typeof createRagService>;
} {
  const embedder = over.embedder instanceof MockEmbedder ? over.embedder : new MockEmbedder();
  const store = over.store instanceof MockStore ? over.store : new MockStore(over.hits ?? []);
  const reranker = new SpyReranker();
  const service = createRagService({
    chunker,
    embedder,
    store,
    ...(over.reranker !== undefined ? { reranker: over.reranker } : { reranker }),
    ...(over.config ? { config: over.config } : {}),
  });
  return { embedder, store, reranker, service };
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

describe("RagService.query", () => {
  it("empty corpus returns empty snippets (not an error)", async () => {
    const { service, embedder, store } = build({ hits: [] });
    const res = await service.query(USER, "anything", { tier: "live" });
    expect(res.snippets).toEqual([]);
    expect(res.usage.candidatesRetrieved).toBe(0);
    expect(res.usage.snippetsReturned).toBe(0);
    // Query embedded once, unbatched, with kind "query".
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]?.kind).toBe("query");
    expect(embedder.calls[0]?.texts).toEqual(["anything"]);
    // Searched under that embed's model with the candidate cut.
    expect(store.searchCalls[0]?.model).toBe(embedder.model);
    expect(store.searchCalls[0]?.k).toBe(ragConfig.candidatesPerLeg);
  });

  it("live tier NEVER touches the reranker (adr §5)", async () => {
    const hits = [makeHit({ chunkId: "c1" }), makeHit({ chunkId: "c2" })];
    const { service, reranker } = build({ hits });
    const res = await service.query(USER, "q", { tier: "live" });
    expect(reranker.calls).toHaveLength(0);
    // Order preserved (no rerank), both returned (under kLive, under budget).
    expect(res.snippets.map((s) => s.chunkId)).toEqual(["c1", "c2"]);
  });

  it("deliberate tier reranks when a reranker is present", async () => {
    const hits = [makeHit({ chunkId: "c1" }), makeHit({ chunkId: "c2" })];
    const { service, reranker } = build({ hits });
    const res = await service.query(USER, "q", { tier: "deliberate" });
    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0]?.k).toBe(ragConfig.kDeliberate);
    // SpyReranker reverses order — proves the returned list came from the reranker.
    expect(res.snippets.map((s) => s.chunkId)).toEqual(["c2", "c1"]);
  });

  it("deliberate tier skips cleanly when no reranker is configured", async () => {
    const hits = [makeHit({ chunkId: "c1" }), makeHit({ chunkId: "c2" })];
    const store = new MockStore(hits);
    const service = createRagService({ chunker, embedder: new MockEmbedder(), store });
    const res = await service.query(USER, "q", { tier: "deliberate" });
    // No throw, original order preserved (identity fallthrough).
    expect(res.snippets.map((s) => s.chunkId)).toEqual(["c1", "c2"]);
  });

  it("trims trailing snippets until Σ tokens ≤ tokenBudget", async () => {
    // Three ~equal-size snippets; a budget between 2x and 3x their size keeps 2.
    const body = "x".repeat(38);
    const hits = [
      makeHit({ chunkId: "c1", header: "H", content: body }),
      makeHit({ chunkId: "c2", header: "H", content: body }),
      makeHit({ chunkId: "c3", header: "H", content: body }),
    ];
    const per = approxTokens(`H ${body}`);
    const { service } = build({ hits });
    // Live tier (never reranks) keeps store order, so the budget trim is isolated.
    const res = await service.query(USER, "q", {
      tier: "live",
      tokenBudget: per * 2 + 1, // room for exactly two
    });
    expect(res.snippets.map((s) => s.chunkId)).toEqual(["c1", "c2"]);
    const total = res.snippets.reduce((n, s) => n + approxTokens(`${s.header} ${s.content}`), 0);
    expect(total).toBeLessThanOrEqual(per * 2 + 1);
  });

  it("honors an explicit k override before the budget trim", async () => {
    const hits = [
      makeHit({ chunkId: "c1" }),
      makeHit({ chunkId: "c2" }),
      makeHit({ chunkId: "c3" }),
    ];
    const { service } = build({ hits });
    const res = await service.query(USER, "q", { tier: "deliberate", k: 1 });
    expect(res.snippets.map((s) => s.chunkId)).toEqual(["c3"]); // reversed then k=1
  });
});

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

describe("RagService.ingest", () => {
  it("chunks → embeds (document) → delegates to store.replaceSource", async () => {
    const { service, embedder, store } = build();
    const res = await service.ingest(USER, {
      kind: "context_doc",
      contextDocId: "doc-1",
      title: "Pricing",
      content: "Acme pays 4200 per month.\n\nGrowth plan with 15% annual discount.",
    });
    expect(res.chunks).toBeGreaterThan(0);
    expect(embedder.calls[0]?.kind).toBe("document");
    expect(store.replaceCalls).toHaveLength(1);
    const call = store.replaceCalls[0];
    expect(call?.source).toEqual({ kind: "context_doc", contextDocId: "doc-1" });
    expect(call?.chunks).toHaveLength(res.chunks);
    // Every persisted chunk carries the embed's model + dims (the versioning bar).
    for (const ch of call?.chunks ?? []) {
      expect(ch.model).toBe(embedder.model);
      expect(ch.dims).toBe(embedder.dims);
      expect(ch.embedding).toHaveLength(embedder.dims);
    }
  });

  it("empty content clears stale chunks via replaceSource([]) and embeds nothing", async () => {
    const { service, embedder, store } = build();
    const res = await service.ingest(USER, {
      kind: "context_doc",
      contextDocId: "doc-empty",
      title: "Empty",
      content: "   \n\n  ",
    });
    expect(res.chunks).toBe(0);
    expect(store.replaceCalls).toHaveLength(1);
    expect(store.replaceCalls[0]?.chunks).toEqual([]);
    expect(embedder.calls).toHaveLength(0); // no wasted embed call
  });

  it("re-ingest is idempotent — each run delegates a fresh replaceSource", async () => {
    const { service, store } = build();
    const source = {
      kind: "context_doc" as const,
      contextDocId: "doc-1",
      title: "T",
      content: "one paragraph of source text about Acme pricing details.",
    };
    await service.ingest(USER, source);
    await service.ingest(USER, source);
    expect(store.replaceCalls).toHaveLength(2);
    expect(store.replaceCalls[0]?.source).toEqual(store.replaceCalls[1]?.source);
  });

  it("ingests a meeting, deriving speakers into the header seam", async () => {
    const { service, store } = build();
    const res = await service.ingest(USER, {
      kind: "meeting",
      meetingId: "m-1",
      title: "Acme call",
      date: "2026-07-19",
      turns: [
        { speaker: "Rep", text: "We can offer the Growth plan.", tsMs: 0 },
        { speaker: "Acme", text: "What is the monthly price?", tsMs: 1000 },
      ],
    });
    expect(res.chunks).toBeGreaterThan(0);
    expect(store.replaceCalls[0]?.source).toEqual({ kind: "meeting", meetingId: "m-1" });
    // Header carries title, date, and derived speakers (chunker builds it).
    expect(store.replaceCalls[0]?.chunks[0]?.header).toContain("Acme call");
    expect(store.replaceCalls[0]?.chunks[0]?.header).toContain("Rep");
  });

  it("propagates SOURCE_TOO_LARGE from the chunker (no silent catch)", async () => {
    // A tiny config forces one chunk per paragraph, past a maxChunksPerSource of 1.
    const config: RagConfig = {
      ...ragConfig,
      targetChunkTokens: 1,
      maxChunkTokens: 4,
      maxChunksPerSource: 1,
    };
    const { service } = build({ config });
    await expect(
      service.ingest(USER, {
        kind: "context_doc",
        contextDocId: "doc-big",
        title: "Big",
        content: "aa\n\nbb\n\ncc",
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isRagError(err) && err.code === "SOURCE_TOO_LARGE",
    );
  });

  it("rejects a malformed ingest source at the zod boundary", async () => {
    const { service } = build();
    await expect(
      // @ts-expect-error — intentionally invalid shape to prove boundary parsing.
      service.ingest(USER, { kind: "context_doc", contextDocId: "d" }),
    ).rejects.toThrow();
  });
});
