import { afterEach, describe, expect, it, vi } from "vitest";

import { RagError } from "../ports.js";
import type { RagHit } from "../ports.js";
import {
  createVoyageAdapter,
  voyageAdapterFromEnv,
  type VoyageConfig,
  type VoyageUsageLog,
} from "./voyage.js";

/**
 * Voyage adapter unit tests — the vendor HTTP is `vi.stubGlobal("fetch", …)`, so
 * NO network and NO key. Covers the contract the service leans on: request shape
 * (model tier / input_type / output_dimension), document batching vs unbatched
 * queries, the dims-mismatch guard, timeout/HTTP error mapping to typed
 * EMBEDDER_FAILED, rerank reordering, and that exactly one usage line is emitted.
 */

const config: VoyageConfig = {
  embedBatchSize: 2,
  queryEmbedTimeoutMs: 50,
  ingestEmbedTimeoutMs: 50,
};

const DIMS = 1024;
/** A 1024-dim vector filled with `v` (norm well-defined for a nonzero fill). */
const vec = (v: number): number[] => Array<number>(DIMS).fill(v);

interface EmbeddingItem {
  index: number;
  embedding: number[];
}

function embeddingsBody(
  items: EmbeddingItem[],
  model = "voyage-4-lite",
  tokens = 7,
): unknown {
  return { object: "list", data: items, model, usage: { total_tokens: tokens } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Parse the JSON body a fetch call was invoked with. */
function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit | undefined;
  const raw = (init?.body ?? "") as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voyage embedder — request shape", () => {
  it("embeds a query with the lite model, input_type=query, 1024 dims", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(embeddingsBody([{ index: 0, embedding: vec(0.1) }])));
    vi.stubGlobal("fetch", fetchMock);

    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    const res = await embedder.embed(["small cat"], { kind: "query" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect((init as RequestInit).method).toBe("POST");
    const body = bodyOf(fetchMock.mock.calls[0] ?? []);
    expect(body.model).toBe("voyage-4-lite");
    expect(body.input_type).toBe("query");
    expect(body.output_dimension).toBe(1024);
    expect(body.input).toEqual(["small cat"]);

    expect(res.vectors).toHaveLength(1);
    expect(res.dims).toBe(1024);
    expect(res.model).toBe("voyage-4-lite");
    expect(res.usage.tokens).toBe(7);
  });

  it("uses the voyage-4 document model + input_type=document for ingest", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(embeddingsBody([{ index: 0, embedding: vec(0.2) }], "voyage-4")),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    await embedder.embed(["a document"], { kind: "document" });

    const body = bodyOf(fetchMock.mock.calls[0] ?? []);
    expect(body.model).toBe("voyage-4");
    expect(body.input_type).toBe("document");
  });
});

describe("voyage embedder — batching", () => {
  it("splits documents into embedBatchSize batches and aggregates", async () => {
    // 3 texts, batch size 2 → two calls (2 + 1), tokens summed, order preserved.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          embeddingsBody(
            [
              { index: 0, embedding: vec(0.1) },
              { index: 1, embedding: vec(0.2) },
            ],
            "voyage-4",
            5,
          ),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(embeddingsBody([{ index: 0, embedding: vec(0.3) }], "voyage-4", 3)),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    const res = await embedder.embed(["one", "two", "three"], { kind: "document" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0] ?? []).input).toEqual(["one", "two"]);
    expect(bodyOf(fetchMock.mock.calls[1] ?? []).input).toEqual(["three"]);
    expect(res.vectors).toHaveLength(3);
    expect(res.usage.tokens).toBe(8);
  });

  it("never batches a query — one call even past embedBatchSize", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        embeddingsBody([
          { index: 0, embedding: vec(0.1) },
          { index: 1, embedding: vec(0.2) },
          { index: 2, embedding: vec(0.3) },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    const res = await embedder.embed(["a", "b", "c"], { kind: "query" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.vectors).toHaveLength(3);
  });
});

describe("voyage embedder — error mapping", () => {
  it("maps a 429 to EMBEDDER_FAILED (status only, no body echoed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "rate" }, 429)),
    );
    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    await expect(embedder.embed(["x"], { kind: "query" })).rejects.toMatchObject({
      code: "EMBEDDER_FAILED",
    });
  });

  it("maps a 500 to EMBEDDER_FAILED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 500)),
    );
    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    await expect(embedder.embed(["x"], { kind: "query" })).rejects.toMatchObject({
      code: "EMBEDDER_FAILED",
    });
  });

  it("guards a dims mismatch (≠1024) as EMBEDDER_FAILED", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(embeddingsBody([{ index: 0, embedding: Array<number>(512).fill(0.1) }])),
        ),
    );
    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    const err = await embedder.embed(["x"], { kind: "query" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RagError);
    expect((err as RagError).code).toBe("EMBEDDER_FAILED");
    expect((err as RagError).message).toContain("512");
  });

  it("maps an aborted (timed-out) request to EMBEDDER_FAILED", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its AbortSignal fires — the timeout drives it.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );
    const { embedder } = createVoyageAdapter({ apiKey: "k", config });
    const settled = embedder.embed(["x"], { kind: "query" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(config.queryEmbedTimeoutMs + 1);
    const err = await settled;
    expect(err).toBeInstanceOf(RagError);
    expect((err as RagError).code).toBe("EMBEDDER_FAILED");
    expect((err as RagError).message).toContain("timed out");
    vi.useRealTimers();
  });
});

describe("voyage embedder — usage log", () => {
  it("emits exactly one usage line with vendor/model/tokens/user_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(embeddingsBody([{ index: 0, embedding: vec(0.1) }], "voyage-4-lite", 11)),
        ),
    );
    const logUsage = vi.fn<(entry: VoyageUsageLog) => void>();
    const { embedder } = createVoyageAdapter({ apiKey: "k", config, logUsage });

    await embedder.embed(["hello"], { kind: "query", userId: "user-123" });

    expect(logUsage).toHaveBeenCalledTimes(1);
    expect(logUsage).toHaveBeenCalledWith({
      vendor: "voyage",
      model: "voyage-4-lite",
      tokens: 11,
      user_id: "user-123",
    });
  });

  it("logs user_id null when no owner is threaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(embeddingsBody([{ index: 0, embedding: vec(0.1) }]))),
    );
    const logUsage = vi.fn<(entry: VoyageUsageLog) => void>();
    const { embedder } = createVoyageAdapter({ apiKey: "k", config, logUsage });

    await embedder.embed(["hello"], { kind: "query" });
    expect(logUsage.mock.calls[0]?.[0].user_id).toBeNull();
  });
});

describe("voyage reranker", () => {
  const hits: RagHit[] = [
    { chunkId: "a", content: "derivatives pricing", header: "", score: 0.1, contextDocId: "d", meetingId: null },
    { chunkId: "b", content: "a small kitten", header: "", score: 0.2, contextDocId: "d", meetingId: null },
  ];

  it("reorders hits by the vendor relevance and rewrites score", async () => {
    // Vendor puts index 1 (kitten) first for the query about cats.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
        model: "rerank-2.5-lite",
        usage: { total_tokens: 4 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const logUsage = vi.fn<(entry: VoyageUsageLog) => void>();
    const { reranker } = createVoyageAdapter({ apiKey: "k", config, logUsage });

    const out = await reranker.rerank("small cat", hits, 2);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.voyageai.com/v1/rerank");
    const body = bodyOf(fetchMock.mock.calls[0] ?? []);
    expect(body.model).toBe("rerank-2.5-lite");
    expect(body.top_k).toBe(2);
    expect(out.map((h) => h.chunkId)).toEqual(["b", "a"]);
    expect(out[0]?.score).toBe(0.9);
    expect(logUsage).toHaveBeenCalledTimes(1);
    expect(logUsage.mock.calls[0]?.[0].model).toBe("rerank-2.5-lite");
  });

  it("short-circuits an empty hit list without a network call", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { reranker } = createVoyageAdapter({ apiKey: "k", config });
    expect(await reranker.rerank("q", [], 5)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("voyageAdapterFromEnv", () => {
  it("throws RAG_NOT_CONFIGURED when VOYAGE_API_KEY is absent", () => {
    expect(() => voyageAdapterFromEnv({}, config)).toThrowError(
      expect.objectContaining({ code: "RAG_NOT_CONFIGURED" }) as Error,
    );
  });

  it("builds an adapter when the key is present", () => {
    const adapter = voyageAdapterFromEnv({ VOYAGE_API_KEY: "k" }, config);
    expect(adapter.embedder).toBeDefined();
    expect(adapter.reranker).toBeDefined();
  });
});
