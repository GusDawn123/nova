import { afterEach, describe, expect, it, vi } from "vitest";

import { ragConfig } from "./config.js";
import type { RagHit } from "./ports.js";
import { createRagService } from "./service.js";
import {
  createVoyageAdapter,
  type VoyageUsageLog,
} from "./adapters/voyage.js";
import { MockEmbedder, MockStore, SpyReranker, makeHit } from "./testing/mock-rag.js";

/**
 * [rag-meter] Phase 6 metering wire-through for the Voyage sinks (adr-0007;
 * DESIGN/metering.md §Wire-through):
 *   - the usage log entry now carries its `kind` ("embedding" | "rerank") so the
 *     app.ts sink can map it to `embedding_tokens` / `rerank_requests` without
 *     model-name sniffing — with the TRUE per-tier vendor model kept;
 *   - the `Reranker` port gains the `userId` it has been missing (the standing
 *     opener): the voyage adapter stamps it on the usage line, and
 *     `RagService.query` threads the caller's userId through.
 */

const config = ragConfig;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const vec = (fill: number): number[] => new Array<number>(1024).fill(fill);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voyage usage log [rag-meter] — kind + userId", () => {
  it("[rag-meter] an embed usage line carries kind 'embedding' + the true vendor model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: [{ index: 0, embedding: vec(0.1) }],
          model: "voyage-4-lite",
          usage: { total_tokens: 11 },
        }),
      ),
    );
    const logUsage = vi.fn<(entry: VoyageUsageLog) => void>();
    const { embedder } = createVoyageAdapter({ apiKey: "k", config, logUsage });

    await embedder.embed(["hello"], { kind: "query", userId: "user-123" });

    expect(logUsage).toHaveBeenCalledWith({
      vendor: "voyage",
      kind: "embedding",
      model: "voyage-4-lite",
      tokens: 11,
      user_id: "user-123",
    });
  });

  it("[rag-meter] a rerank usage line carries kind 'rerank' + the threaded userId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: [{ index: 0, relevance_score: 0.9 }],
          model: "rerank-2.5-lite",
          usage: { total_tokens: 4 },
        }),
      ),
    );
    const logUsage = vi.fn<(entry: VoyageUsageLog) => void>();
    const { reranker } = createVoyageAdapter({ apiKey: "k", config, logUsage });

    const hits: RagHit[] = [
      {
        chunkId: "a",
        content: "a small kitten",
        header: "",
        score: 0.1,
        contextDocId: "d",
        meetingId: null,
      },
    ];
    await reranker.rerank("small cat", hits, 1, "user-123");

    expect(logUsage).toHaveBeenCalledWith({
      vendor: "voyage",
      kind: "rerank",
      model: "rerank-2.5-lite",
      tokens: 4,
      user_id: "user-123",
    });
  });
});

describe("RagService.query [rag-meter] — reranker userId threading", () => {
  it("[rag-meter] the deliberate tier passes the caller's userId to the reranker", async () => {
    const hits = [makeHit({ chunkId: "a" }), makeHit({ chunkId: "b" })];
    const reranker = new SpyReranker();
    const service = createRagService({
      chunker: {
        chunkTranscript: () => [],
        chunkDoc: () => [],
      },
      embedder: new MockEmbedder(),
      store: new MockStore(hits),
      reranker,
    });

    await service.query("user-77", "the query", { tier: "deliberate" });

    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0]?.userId).toBe("user-77");
  });
});
