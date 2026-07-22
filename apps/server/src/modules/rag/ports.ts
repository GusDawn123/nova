import { z } from "zod";

import type { ChunkConfig } from "./config.js";

/**
 * modules/rag contracts (Phase 4). This file defines the SEAMS only — the four
 * swappable ports (Chunker, Embedder, VectorStore, Reranker), the data shapes
 * that cross the module boundary (zod-validated), and the typed error taxonomy.
 * Later tasks implement `RagService` over these ports and build the Voyage /
 * pgvector adapters behind `adapters/` (RULES §5). No vendor SDKs, no network,
 * no DB in this file.
 *
 * Design sources: `docs/DESIGN/rag-memory.md`, `docs/DECISIONS/adr-0005-rag-memory.md`.
 */

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Every RAG failure a caller reasons about is one of these codes, so degrade
 * policy branches on a closed set instead of sniffing vendor strings:
 * - `RAG_NOT_CONFIGURED` — no embeddings key; the server still boots, ingest and
 *   live retrieval degrade explicitly (same posture as keyless STT).
 * - `EMBEDDER_FAILED` — the embeddings vendor errored or timed out.
 * - `STORE_FAILED` — the vector store (Postgres) rejected a read/write.
 * - `SOURCE_TOO_LARGE` — the chunker hit `maxChunksPerSource` for one source.
 */
export type RagErrorCode =
  | "RAG_NOT_CONFIGURED"
  | "EMBEDDER_FAILED"
  | "STORE_FAILED"
  | "SOURCE_TOO_LARGE";

/** Optional cause, threaded to `Error`'s `cause` without violating exactOptional. */
interface RagErrorOptions {
  cause?: unknown;
}

function errorOptions(options?: RagErrorOptions): ErrorOptions | undefined {
  return options?.cause !== undefined ? { cause: options.cause } : undefined;
}

/** Base typed RAG error, discriminated by `code` (house pattern: modules/llm). */
export class RagError extends Error {
  readonly code: RagErrorCode;

  constructor(code: RagErrorCode, message?: string, options?: RagErrorOptions) {
    super(message ?? code, errorOptions(options));
    this.name = "RagError";
    this.code = code;
  }

  static notConfigured(message?: string, options?: RagErrorOptions): RagError {
    return new RagError("RAG_NOT_CONFIGURED", message, options);
  }

  static embedderFailed(message?: string, options?: RagErrorOptions): RagError {
    return new RagError("EMBEDDER_FAILED", message, options);
  }

  static storeFailed(message?: string, options?: RagErrorOptions): RagError {
    return new RagError("STORE_FAILED", message, options);
  }

  static sourceTooLarge(message?: string, options?: RagErrorOptions): RagError {
    return new RagError("SOURCE_TOO_LARGE", message, options);
  }
}

/** Narrow an unknown thrown value to our taxonomy. */
export function isRagError(value: unknown): value is RagError {
  return value instanceof RagError;
}

// ---------------------------------------------------------------------------
// Chunker port + its data shapes
// ---------------------------------------------------------------------------

/**
 * One diarized transcript turn as loaded from the DB. `speaker`/`tsMs` are
 * nullable because the STT vendor may not diarize or timestamp every final.
 */
export const transcriptTurnSchema = z.object({
  speaker: z.string().nullable(),
  text: z.string(),
  tsMs: z.number().nullable(),
});
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

/** Source metadata that seeds a chunk's contextual header. */
export const sourceMetaSchema = z.object({
  title: z.string(),
  date: z.string().optional(),
  speakers: z.array(z.string()).optional(),
});
export type SourceMeta = z.infer<typeof sourceMetaSchema>;

/**
 * A chunk before embedding — what the pure chunker emits. `header` is the
 * zero-cost contextual line prepended for both embedding and full-text indexing;
 * `tokenCount` is the estimated size of `header + " " + content`.
 */
export const chunkDraftSchema = z.object({
  content: z.string(),
  header: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
});
export type ChunkDraft = z.infer<typeof chunkDraftSchema>;

/**
 * The pure, deterministic chunker. Zero I/O, zero clock: same input → identical
 * output, always. Transcripts pack by diarized turn; docs pack by paragraph.
 * Throws {@link RagError} `SOURCE_TOO_LARGE` past `cfg.maxChunksPerSource`.
 */
export interface Chunker {
  chunkTranscript(
    turns: TranscriptTurn[],
    meta: SourceMeta,
    cfg: ChunkConfig,
  ): ChunkDraft[];
  chunkDoc(content: string, meta: SourceMeta, cfg: ChunkConfig): ChunkDraft[];
}

// ---------------------------------------------------------------------------
// Embedder port
// ---------------------------------------------------------------------------

/**
 * The embeddings vendor port (Voyage adapter satisfies it). `kind` picks the
 * `input_type` and model tier — `query` (hot path, cheaper/faster model) vs
 * `document` (batched background indexing). `userId` threads through for usage
 * metering. Failure is signalled by throwing a `RagError`.
 *
 * The returned `model` is the **embedding-space identifier** (adr-0005 §2) —
 * the one name used for storage (`embeddings.model`) and search filtering,
 * identical across both kinds of a shared-space family. The per-call vendor
 * model appears in usage logs only, never here.
 */
export interface Embedder {
  embed(
    texts: string[],
    opts: { kind: "query" | "document"; userId?: string },
  ): Promise<{
    vectors: number[][];
    model: string;
    dims: number;
    usage: { tokens: number };
  }>;
}

// ---------------------------------------------------------------------------
// VectorStore port + its data shapes
// ---------------------------------------------------------------------------

/**
 * Which parent a source belongs to. Discriminated union (RULES §10) — exactly
 * one parent id is present, mirroring the two-way CHECK on the `chunks` table.
 */
export const ragSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("context_doc"), contextDocId: z.string() }),
  z.object({ kind: z.literal("meeting"), meetingId: z.string() }),
]);
export type RagSource = z.infer<typeof ragSourceSchema>;

/** A chunk carrying its embedding — what the store persists for one source. */
export const embeddedChunkSchema = chunkDraftSchema.extend({
  embedding: z.array(z.number()),
  model: z.string(),
  dims: z.number().int().positive(),
});
export type EmbeddedChunk = z.infer<typeof embeddedChunkSchema>;

/**
 * One retrieval result. Exactly one of `contextDocId` / `meetingId` is non-null;
 * both fields are always present (nullable, not optional) so callers can branch
 * on source without shape-sniffing.
 */
export const ragHitSchema = z.object({
  chunkId: z.string(),
  content: z.string(),
  header: z.string(),
  score: z.number(),
  contextDocId: z.string().nullable(),
  meetingId: z.string().nullable(),
});
export type RagHit = z.infer<typeof ragHitSchema>;

/**
 * The vector store port (pgvector adapter satisfies it). `replaceSource` is the
 * idempotent upsert: soft-delete a source's existing chunks, insert fresh.
 * `search` runs one user-scoped hybrid round trip. Failure throws `RagError`.
 */
export interface VectorStore {
  replaceSource(
    userId: string,
    source: RagSource,
    chunks: EmbeddedChunk[],
  ): Promise<void>;
  search(
    userId: string,
    q: { vector: number[]; text: string; model: string; k: number },
  ): Promise<RagHit[]>;
}

// ---------------------------------------------------------------------------
// Reranker port
// ---------------------------------------------------------------------------

/**
 * The deliberate-tier reranker port (Voyage rerank adapter satisfies it). The
 * default implementation is identity — a keyless deploy still works, and the
 * live tier never reranks. Failure throws `RagError`.
 */
export interface Reranker {
  rerank(query: string, hits: RagHit[], k: number): Promise<RagHit[]>;
}
