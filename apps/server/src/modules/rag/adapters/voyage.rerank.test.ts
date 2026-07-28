import { afterEach, describe, expect, it, vi } from "vitest";
import type { RagHit } from "../ports.js";
import {
  bodyOf,
  jsonResponse,
  voyageTestConfig as config,
} from "../testing/voyage-fixtures.js";
import {
  createVoyageAdapter,
  voyageAdapterFromEnv,
  type VoyageUsageLog,
} from "./voyage.js";

/**
 * Voyage RERANKER unit tests plus the env-construction seam. Vendor HTTP is
 * stubbed, so no network and no key.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voyage reranker", () => {
  const hits: RagHit[] = [
    {
      chunkId: "a",
      content: "derivatives pricing",
      header: "",
      score: 0.1,
      contextDocId: "d",
      meetingId: null,
    },
    {
      chunkId: "b",
      content: "a small kitten",
      header: "",
      score: 0.2,
      contextDocId: "d",
      meetingId: null,
    },
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
