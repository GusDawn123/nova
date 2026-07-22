import { z } from "zod";

import type { RagConfig } from "../config.js";
import { RagError } from "../ports.js";
import type { Embedder, RagHit, Reranker } from "../ports.js";

/**
 * Voyage AI adapter (Phase 4) — the ONLY place the embeddings/rerank vendor HTTP
 * lives (RULES §2/§5). Plain `fetch` (no SDK dependency), every response
 * zod-parsed at the boundary, every failure mapped to a typed {@link RagError}
 * (never a raw throw). Satisfies BOTH the {@link Embedder} and {@link Reranker}
 * ports so one API key powers ingest embedding, hot-path query embedding, and
 * deliberate-tier reranking.
 *
 * Design source: `docs/DECISIONS/adr-0005-rag-memory.md` §§1,5.
 *
 * Two-speed on one embedding space (adr §1): `voyage-4` for `document`
 * (batched background indexing) and `voyage-4-lite` for `query` (hot path), both
 * truncated to 1024 Matryoshka dims — index high-quality, query cheap/fast, no
 * dual index. A dims-mismatch guard turns a silent Matryoshka misconfig into a
 * loud {@link RagError} `EMBEDDER_FAILED`.
 *
 * Error posture (adr §1): a missing key is `RAG_NOT_CONFIGURED` (surfaced by the
 * env factory, so a keyless deploy degrades, never crashes); an auth rejection
 * (401/403) once a key IS present is a genuine vendor failure → `EMBEDDER_FAILED`
 * with the cause, NOT `RAG_NOT_CONFIGURED`.
 *
 * Logging (RULES §6): every embed/rerank invocation emits exactly ONE structured
 * usage line `{ vendor, model, tokens, user_id }` (metering-ready). Input texts
 * and snippet content are NEVER logged — not the request body, not on error.
 */

// ---------------------------------------------------------------------------
// Endpoints, models, and the fixed output dimensionality (adr §1).
// ---------------------------------------------------------------------------

const EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
const RERANK_URL = "https://api.voyageai.com/v1/rerank";

/** Higher-quality model for background document indexing. */
const DOCUMENT_MODEL = "voyage-4";
/** Cheaper/faster model for hot-path query embedding (same embedding space). */
const QUERY_MODEL = "voyage-4-lite";
/** Deliberate-tier reranker (adr §5: live NEVER reranks — enforced by the service). */
const RERANK_MODEL = "rerank-2.5-lite";
/** Matryoshka output dimensionality — MUST match the `halfvec(1024)` column. */
const EMBED_DIMS = 1024;

/** The config knobs the Voyage adapter reads (timeouts + batch size). */
export type VoyageConfig = Pick<
  RagConfig,
  "embedBatchSize" | "queryEmbedTimeoutMs" | "ingestEmbedTimeoutMs"
>;

// ---------------------------------------------------------------------------
// Vendor payload schemas (zod-parsed — RULES: parse every boundary).
// ---------------------------------------------------------------------------

/** The subset of Voyage's `/embeddings` response we rely on. Unknown keys ignored. */
const embeddingsResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()),
    }),
  ),
  model: z.string(),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }),
});

/** The subset of Voyage's `/rerank` response we rely on. */
const rerankResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      relevance_score: z.number(),
    }),
  ),
  model: z.string(),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }),
});

// ---------------------------------------------------------------------------
// Usage logging (metering-ready; never carries input text).
// ---------------------------------------------------------------------------

/** One structured usage line. `user_id` is null when the port carries no owner. */
export interface VoyageUsageLog {
  readonly vendor: "voyage";
  readonly model: string;
  readonly tokens: number;
  readonly user_id: string | null;
}

/** Default sink: one info-level JSON line. Only counts/model/user — never texts. */
function defaultLogUsage(entry: VoyageUsageLog): void {
  console.info(JSON.stringify({ level: "info", msg: "rag.usage", ...entry }));
}

// ---------------------------------------------------------------------------
// HTTP with a hard timeout + typed error mapping.
// ---------------------------------------------------------------------------

/**
 * POST JSON to Voyage under an {@link AbortController} deadline. Returns the raw
 * parsed body as `unknown` (the caller zod-validates it). Every failure — abort/
 * timeout, network error, non-2xx, malformed JSON — becomes `EMBEDDER_FAILED`
 * with the cause preserved. The request body and any error-response body are NEVER
 * put in the message (they may echo input text).
 */
async function voyagePost(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    throw RagError.embedderFailed(
      aborted
        ? `voyage: request timed out after ${String(timeoutMs)}ms`
        : "voyage: network error",
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Status only — the response body can echo the input text; never surface it.
    throw RagError.embedderFailed(`voyage: HTTP ${String(res.status)}`, {
      cause: new Error(
        `voyage responded ${String(res.status)} ${res.statusText}`,
      ),
    });
  }

  try {
    const body: unknown = await res.json();
    return body;
  } catch (cause) {
    throw RagError.embedderFailed("voyage: malformed JSON response", { cause });
  }
}

/** Split `items` into consecutive slices of at most `size` (>=1). */
function batched<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Render a hit for reranking with its contextual header (as it was indexed). */
function renderHitForRerank(hit: RagHit): string {
  return hit.header.trim().length > 0
    ? `${hit.header}\n${hit.content}`
    : hit.content;
}

// ---------------------------------------------------------------------------
// Adapter factory.
// ---------------------------------------------------------------------------

/** Construction options. `apiKey` required (env factory guards its presence). */
export interface VoyageAdapterOptions {
  readonly apiKey: string;
  readonly config: VoyageConfig;
  /** Usage-line sink; defaults to one info-level JSON line. Injected in tests. */
  readonly logUsage?: (entry: VoyageUsageLog) => void;
}

/**
 * Build the Voyage {@link Embedder} + {@link Reranker} pair from an explicit key.
 * Pure (no env read) so tests drive it directly with `vi.stubGlobal("fetch", …)`.
 */
export function createVoyageAdapter(opts: VoyageAdapterOptions): {
  embedder: Embedder;
  reranker: Reranker;
} {
  const { apiKey, config } = opts;
  const logUsage = opts.logUsage ?? defaultLogUsage;

  const embedder: Embedder = {
    async embed(texts, embedOpts) {
      const isQuery = embedOpts.kind === "query";
      const requestModel = isQuery ? QUERY_MODEL : DOCUMENT_MODEL;
      const inputType = isQuery ? "query" : "document";
      const timeoutMs = isQuery
        ? config.queryEmbedTimeoutMs
        : config.ingestEmbedTimeoutMs;
      // Queries are ALWAYS one unbatched call; documents chunk into batches.
      const batches = isQuery ? [texts] : batched(texts, config.embedBatchSize);

      const vectors: number[][] = [];
      let tokens = 0;
      let reportedModel = requestModel;

      for (const batch of batches) {
        if (batch.length === 0) continue;
        const raw = await voyagePost(
          EMBEDDINGS_URL,
          apiKey,
          {
            model: requestModel,
            input: batch,
            input_type: inputType,
            output_dimension: EMBED_DIMS,
          },
          timeoutMs,
        );
        const parsed = embeddingsResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw RagError.embedderFailed(
            `voyage: unparseable embeddings response — ${parsed.error.message}`,
            { cause: parsed.error },
          );
        }
        reportedModel = parsed.data.model;
        tokens += parsed.data.usage.total_tokens;
        // Voyage returns in request order, but sort by `index` to be certain.
        const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
        for (const item of ordered) {
          if (item.embedding.length !== EMBED_DIMS) {
            // Dims guard: a silent Matryoshka misconfig would poison the index.
            throw RagError.embedderFailed(
              `voyage: expected ${String(EMBED_DIMS)}-dim embedding, got ${String(
                item.embedding.length,
              )}`,
            );
          }
          vectors.push(item.embedding);
        }
      }

      logUsage({
        vendor: "voyage",
        model: reportedModel,
        tokens,
        user_id: embedOpts.userId ?? null,
      });

      return { vectors, model: reportedModel, dims: EMBED_DIMS, usage: { tokens } };
    },
  };

  const reranker: Reranker = {
    async rerank(query, hits, k) {
      if (hits.length === 0) return [];
      const topK = Math.min(k, hits.length);
      // Rerank is deliberate-tier (post-call, off the hot path — adr §5), so it
      // gets the generous ingest deadline, never the tight query one.
      const raw = await voyagePost(
        RERANK_URL,
        apiKey,
        {
          model: RERANK_MODEL,
          query,
          documents: hits.map(renderHitForRerank),
          top_k: topK,
        },
        config.ingestEmbedTimeoutMs,
      );
      const parsed = rerankResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw RagError.embedderFailed(
          `voyage: unparseable rerank response — ${parsed.error.message}`,
          { cause: parsed.error },
        );
      }

      logUsage({
        vendor: "voyage",
        model: parsed.data.model,
        tokens: parsed.data.usage.total_tokens,
        user_id: null,
      });

      const reordered: RagHit[] = [];
      for (const item of parsed.data.data) {
        const hit = hits[item.index];
        if (hit === undefined) {
          throw RagError.embedderFailed(
            `voyage: rerank returned out-of-range index ${String(item.index)}`,
          );
        }
        // Carry the rerank relevance as the new score (the deliberate ordering).
        reordered.push({ ...hit, score: item.relevance_score });
      }
      return reordered;
    },
  };

  return { embedder, reranker };
}

// ---------------------------------------------------------------------------
// Env factory (lazy, like db/client.ts).
// ---------------------------------------------------------------------------

/** Re-parsed at this boundary (RULES: parse every boundary), local to the adapter. */
const voyageEnvSchema = z.object({ VOYAGE_API_KEY: z.string().min(1) });

/**
 * Build the adapter from `process.env`. A missing/blank `VOYAGE_API_KEY` throws
 * {@link RagError} `RAG_NOT_CONFIGURED` (adr §1) — the caller degrades ingest and
 * live retrieval explicitly instead of crashing the server.
 */
export function voyageAdapterFromEnv(
  source: NodeJS.ProcessEnv,
  config: VoyageConfig,
  logUsage?: (entry: VoyageUsageLog) => void,
): { embedder: Embedder; reranker: Reranker } {
  const parsed = voyageEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw RagError.notConfigured(
      "Voyage is not configured: set VOYAGE_API_KEY to enable RAG embeddings + rerank.",
    );
  }
  return createVoyageAdapter({
    apiKey: parsed.data.VOYAGE_API_KEY,
    config,
    ...(logUsage ? { logUsage } : {}),
  });
}
