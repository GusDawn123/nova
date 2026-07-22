/**
 * modules/rag tunables — one object, one place. Unlike the STT engine's config
 * (parsed from per-session overrides at the boundary), these are process-wide
 * constants: the chunker, retrieval SQL, and the completion sweeper all read
 * from the same frozen defaults. Every knob is commented with WHY, not just what.
 *
 * Design sources: `docs/DESIGN/rag-memory.md`, `docs/DECISIONS/adr-0005-rag-memory.md`.
 */
export interface RagConfig {
  /** Soft target per chunk. ~400 tokens balances retrieval precision against
   * context density — big enough to carry meaning, small enough to be specific. */
  readonly targetChunkTokens: number;
  /** Hard ceiling per chunk. A packed window never grows past this; a single
   * unit (turn/paragraph) above it is split on sentence boundaries. */
  readonly maxChunkTokens: number;
  /** Doc overlap as a fraction of window tokens (~15%) — carried as trailing
   * whole sentences so a fact straddling a boundary survives in both chunks. */
  readonly docOverlapRatio: number;
  /** Ceiling on chunks emitted for one source. Guards against an unbounded embed
   * bill from one pathological upload; past it the chunker throws SOURCE_TOO_LARGE. */
  readonly maxChunksPerSource: number;
  /** Candidates pulled per retrieval leg (semantic + full-text) before RRF
   * fusion. ~30 is enough headroom for fusion to reorder without over-scanning. */
  readonly candidatesPerLeg: number;
  /** Reciprocal-rank-fusion constant `1/(rrfK + rank)`. ~50 is the community
   * default that keeps any single leg from dominating the fused order. */
  readonly rrfK: number;
  /** Snippets returned on the live tier — small, because the in-call LLM budget
   * is tight and retrieval must shrink, never delay, the first token. */
  readonly kLive: number;
  /** Snippets returned on the deliberate tier — larger; post-call quality wins
   * over latency here. */
  readonly kDeliberate: number;
  /** Default token budget a query trims its snippets to when the caller sets none. */
  readonly defaultTokenBudgetTokens: number;
  /** Hot-path query-embed timeout. Tight: a slow embed must fail fast so the live
   * path degrades (drops RAG) instead of stalling a suggestion. */
  readonly queryEmbedTimeoutMs: number;
  /** Background ingest-embed timeout. Generous: batched document embedding off
   * the hot path can afford to wait. */
  readonly ingestEmbedTimeoutMs: number;
  /** Completion-sweeper interval. ~20s meets the <60s freshness bar with 3x
   * headroom without hammering the DB. */
  readonly sweepIntervalMs: number;
  /** Meetings ingested per sweep tick — bounds burst load from many calls ending
   * at once. */
  readonly sweepBatchSize: number;
  /** Texts per embedder batch call — amortizes request overhead while staying
   * under vendor array-size limits. */
  readonly embedBatchSize: number;
}

/** The process-wide RAG defaults. */
export const ragConfig: RagConfig = {
  targetChunkTokens: 400,
  maxChunkTokens: 512,
  docOverlapRatio: 0.15,
  maxChunksPerSource: 2000,
  candidatesPerLeg: 30,
  rrfK: 50,
  kLive: 8,
  kDeliberate: 12,
  defaultTokenBudgetTokens: 1500,
  queryEmbedTimeoutMs: 2500,
  ingestEmbedTimeoutMs: 30000,
  sweepIntervalMs: 20000,
  sweepBatchSize: 5,
  embedBatchSize: 64,
};

/**
 * The subset of {@link RagConfig} the pure chunker depends on. Keeping it a
 * narrow structural type (not the whole config) means tests can drive tiny,
 * deterministic windows without constructing the retrieval/sweep knobs.
 */
export type ChunkConfig = Pick<
  RagConfig,
  | "targetChunkTokens"
  | "maxChunkTokens"
  | "docOverlapRatio"
  | "maxChunksPerSource"
>;
