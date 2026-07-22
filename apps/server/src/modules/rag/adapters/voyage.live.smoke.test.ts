import { describe, expect, it, vi } from "vitest";

import { ragConfig } from "../config.js";
import type { RagHit } from "../ports.js";
import { createVoyageAdapter } from "./voyage.js";

/**
 * Live smoke — runs ONLY when VOYAGE_API_KEY is in the env (CI/local without it
 * skips cleanly). Drives the REAL Voyage endpoints and asserts the properties the
 * product depends on: 1024 dims on both tiers, the two-speed models share an
 * embedding space (a cat query is nearer "kitten" than "financial derivatives"
 * even though docs use voyage-4 and the query uses voyage-4-lite), and rerank
 * surfaces the related passage first. Cost is trivial (a few short strings).
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const key = process.env.VOYAGE_API_KEY;

describe.skipIf(!key)("voyage live smoke", () => {
  it("embeds on a shared space (cat~kitten) and reranks the related doc first", async () => {
    if (!key) return; // narrow for the type checker; skipIf guards runtime
    const { embedder, reranker } = createVoyageAdapter({
      apiKey: key,
      config: ragConfig,
    });

    const contents = ["cat", "kitten", "financial derivatives"];
    const docs = await embedder.embed(contents, { kind: "document" });
    expect(docs.dims).toBe(1024);
    expect(docs.vectors).toHaveLength(3);

    const query = await embedder.embed(["small cat"], { kind: "query" });
    expect(query.dims).toBe(1024);
    // Both kinds report the shared embedding-space id (adr-0005 §2) — the value
    // ingest stores in embeddings.model AND search filters on.
    expect(docs.model).toBe("voyage-4");
    expect(query.model).toBe("voyage-4");
    const q = query.vectors[0];
    const kitten = docs.vectors[1];
    const derivatives = docs.vectors[2];
    expect(q).toBeDefined();
    expect(kitten).toBeDefined();
    expect(derivatives).toBeDefined();
    if (!q || !kitten || !derivatives) return;
    expect(q).toHaveLength(1024);

    // Shared-space property: the cat query is nearer the kitten doc.
    expect(cosine(q, kitten)).toBeGreaterThan(cosine(q, derivatives));

    const hits: RagHit[] = contents.map((c, i) => ({
      chunkId: String(i),
      content: c,
      header: "",
      score: 0,
      contextDocId: "doc",
      meetingId: null,
    }));
    const reranked = await reranker.rerank("small cat", hits, hits.length);
    expect(reranked).toHaveLength(3);
    // The animal doc (cat/kitten), not derivatives, ranks first.
    expect(["cat", "kitten"]).toContain(reranked[0]?.content);
  });
});
