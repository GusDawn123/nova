import type { VoyageConfig } from "../adapters/voyage.js";

/**
 * Shared fixtures for the Voyage adapter suites (`adapters/voyage.*.test.ts`).
 *
 * Extracted when voyage.test.ts passed the ~400-line soft cap (RULES §2) and was
 * split by coverage area — embedding, reranking, retry. These helpers are the only
 * thing the three suites share; each still stubs its own fetch and owns its own
 * hooks, so the files stay independently readable.
 *
 * Lives under `testing/` by the module convention (llm/, stt/, notes/ do the same),
 * which also keeps it out of the metering audit's production file scan.
 */

/** Tight timeouts and a batch size of 2 so batching is observable in two calls. */
export const voyageTestConfig: VoyageConfig = {
  embedBatchSize: 2,
  queryEmbedTimeoutMs: 50,
  ingestEmbedTimeoutMs: 50,
};

export const DIMS = 1024;

/** A 1024-dim vector filled with `v` (norm well-defined for a nonzero fill). */
export const vec = (v: number): number[] => Array<number>(DIMS).fill(v);

export interface EmbeddingItem {
  index: number;
  embedding: number[];
}

export function embeddingsBody(
  items: EmbeddingItem[],
  model = "voyage-4-lite",
  tokens = 7,
): unknown {
  return {
    object: "list",
    data: items,
    model,
    usage: { total_tokens: tokens },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Parse the JSON body a fetch call was invoked with. */
export function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit | undefined;
  const raw = (init?.body ?? "") as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

/** A rerank success body reordering the single hit at `index` with a score. */
export function rerankBody(index: number, score: number): unknown {
  return {
    object: "list",
    data: [{ index, relevance_score: score }],
    model: "rerank-2.5-lite",
    usage: { total_tokens: 2 },
  };
}
