import type {
  Embedder,
  EmbeddedChunk,
  RagHit,
  RagSource,
  Reranker,
  VectorStore,
} from "../ports.js";

/**
 * Deterministic in-memory RAG test doubles for the RagService behavior suite. Zero
 * network, zero DB, zero clock — every call is recorded so a test can assert what
 * the service DID (which port it called, with what), and every return value is
 * fixed or scripted. TEST-ONLY; never imported by production code.
 */

/** One recorded embed invocation. */
export interface RecordedEmbed {
  readonly texts: string[];
  readonly kind: "query" | "document";
  readonly userId?: string;
}

/**
 * Scriptable {@link Embedder}. Returns a fixed unit vector per input text and ONE
 * model/dims for BOTH kinds (mirroring a single shared embedding space, so the
 * store's model filter lines up between ingest and query). Records every call.
 */
export class MockEmbedder implements Embedder {
  readonly calls: RecordedEmbed[] = [];
  readonly model: string;
  readonly dims: number;

  constructor(opts: { model?: string; dims?: number } = {}) {
    this.model = opts.model ?? "mock-embed-1024";
    this.dims = opts.dims ?? 1024;
  }

  embed(
    texts: string[],
    opts: { kind: "query" | "document"; userId?: string },
  ): Promise<{
    vectors: number[][];
    model: string;
    dims: number;
    usage: { tokens: number };
  }> {
    this.calls.push({
      texts,
      kind: opts.kind,
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    });
    // A distinct, deterministic non-zero vector per text (index-seeded), padded to dims.
    const vectors = texts.map((_text, i) => {
      const v = Array<number>(this.dims).fill(0);
      v[i % this.dims] = 1;
      return v;
    });
    const tokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return Promise.resolve({
      vectors,
      model: this.model,
      dims: this.dims,
      usage: { tokens },
    });
  }
}

/** One recorded replaceSource invocation. */
export interface RecordedReplace {
  readonly userId: string;
  readonly source: RagSource;
  readonly chunks: EmbeddedChunk[];
}

/** One recorded search invocation. */
export interface RecordedSearch {
  readonly userId: string;
  readonly text: string;
  readonly model: string;
  readonly k: number;
}

/**
 * Scriptable {@link VectorStore}. `search` returns a preset hit list (default
 * empty — the new-user/empty-corpus case); `replaceSource` records its chunks so a
 * test can prove idempotent delegation. Both calls are recorded.
 */
export class MockStore implements VectorStore {
  readonly replaceCalls: RecordedReplace[] = [];
  readonly searchCalls: RecordedSearch[] = [];
  private hits: RagHit[];

  constructor(hits: RagHit[] = []) {
    this.hits = hits;
  }

  /** Swap the hit list a subsequent `search` will return. */
  setHits(hits: RagHit[]): void {
    this.hits = hits;
  }

  replaceSource(
    userId: string,
    source: RagSource,
    chunks: EmbeddedChunk[],
  ): Promise<void> {
    this.replaceCalls.push({ userId, source, chunks });
    return Promise.resolve();
  }

  search(
    userId: string,
    q: { vector: number[]; text: string; model: string; k: number },
  ): Promise<RagHit[]> {
    this.searchCalls.push({ userId, text: q.text, model: q.model, k: q.k });
    return Promise.resolve([...this.hits]);
  }
}

/** One recorded rerank invocation. */
export interface RecordedRerank {
  readonly query: string;
  readonly hits: RagHit[];
  readonly k: number;
}

/**
 * Spy {@link Reranker}. Records every call and, by default, REVERSES the hit order
 * (then trims to `k`) so a test can prove the deliberate tier actually reranked —
 * and, by its absence from `calls`, that the live tier never did.
 */
export class SpyReranker implements Reranker {
  readonly calls: RecordedRerank[] = [];

  rerank(query: string, hits: RagHit[], k: number): Promise<RagHit[]> {
    this.calls.push({ query, hits: [...hits], k });
    return Promise.resolve([...hits].reverse().slice(0, k));
  }
}

/** Build a {@link RagHit} with sane defaults — override only what a test cares about. */
export function makeHit(over: Partial<RagHit> & { chunkId: string }): RagHit {
  return {
    content: "content",
    header: "Doc: fixture",
    score: 1,
    contextDocId: null,
    meetingId: null,
    ...over,
  };
}
