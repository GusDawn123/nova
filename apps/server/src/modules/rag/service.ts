import { z } from "zod";

import { approxTokens } from "./chunker.js";
import { ragConfig, type RagConfig } from "./config.js";
import { RagError, transcriptTurnSchema } from "./ports.js";
import type {
  Chunker,
  ChunkDraft,
  Embedder,
  EmbeddedChunk,
  RagHit,
  RagSource,
  Reranker,
  SourceMeta,
  TranscriptTurn,
  VectorStore,
} from "./ports.js";

/**
 * RagService (Phase 4) — the ONLY public surface of modules/rag (RULES §5). It
 * orchestrates the four ports into two pipelines and nothing else: it holds no
 * state, opens no sockets, reads no DB for source content (callers load text and
 * pass it in — the service stays pure over its ports, so Phase 7's prefetch cache
 * and the completion sweeper compose on top rather than living inside it).
 *
 *   ingest  — chunk → embed (document) → store.replaceSource (idempotent upsert)
 *   query   — embed (query) → store.search → tier-gated rerank → budget trim
 *
 * Latency law (adr-0005 §8): retrieval SHRINKS, never delays — `query` trims to a
 * token budget and the live tier NEVER reranks (adr §5 is architectural law,
 * enforced here, not in the adapter). Every failure is a typed {@link RagError}
 * (the ports throw them); this service adds no silent catches. Structured logs
 * carry counts only — never snippet or document content (RULES §6).
 *
 * Design sources: `docs/DESIGN/rag-memory.md`, `docs/DECISIONS/adr-0005-rag-memory.md` §§5,6,8.
 */

// ---------------------------------------------------------------------------
// Public boundary shapes (zod-parsed on the way in — RULES: parse every boundary).
// ---------------------------------------------------------------------------

/**
 * What a caller hands `ingest`: a context doc (already-loaded text) or a finished
 * meeting (already-loaded, ts-ordered transcript turns). Discriminated on `kind`
 * so the service branches on a closed set, never a boolean flag (RULES §10). The
 * service does NOT fetch this content — the caller (route / sweeper) loads it.
 */
export const ragIngestSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("context_doc"),
    contextDocId: z.string(),
    title: z.string(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("meeting"),
    meetingId: z.string(),
    title: z.string(),
    date: z.string().optional(),
    turns: z.array(transcriptTurnSchema),
  }),
]);
export type RagIngestSource = z.infer<typeof ragIngestSourceSchema>;

/** Result of an ingest: how many live chunks the source now has. */
export interface RagIngestResult {
  readonly chunks: number;
}

/** The two retrieval tiers (adr §5): `live` never reranks; `deliberate` may. */
export type RagTier = "live" | "deliberate";

/** Query knobs. `k` overrides the tier default count; `tokenBudget` caps Σ tokens. */
export interface RagQueryOpts {
  readonly tier: RagTier;
  readonly k?: number;
  readonly tokenBudget?: number;
}

/** Per-query accounting — counts only, metering-ready, never content. */
export interface RagUsage {
  /** Tokens the query embed billed. */
  readonly embedTokens: number;
  /** Candidates the store returned before rerank/trim. */
  readonly candidatesRetrieved: number;
  /** Snippets returned after tier trim + budget trim. */
  readonly snippetsReturned: number;
}

/** Result of a query: the trimmed snippet list plus its usage accounting. */
export interface RagQueryResult {
  readonly snippets: RagHit[];
  readonly usage: RagUsage;
}

/**
 * Minimal structured-log sink (pino / Fastify `log.info(obj, msg)` shape). Counts
 * only ever cross it — enforced by construction: the service never passes content.
 */
export interface RagLogger {
  info(fields: Record<string, unknown>, msg: string): void;
}

/** Construction dependencies. `reranker`/`logger`/`config` are optional. */
export interface RagServiceDeps {
  readonly chunker: Chunker;
  readonly embedder: Embedder;
  readonly store: VectorStore;
  readonly reranker?: Reranker;
  readonly logger?: RagLogger;
  /** Process-wide tunables; defaults to {@link ragConfig}. Injected tiny in tests. */
  readonly config?: RagConfig;
}

/** The public service contract — the only thing routes/sweeper are allowed to touch. */
export interface RagService {
  ingest(userId: string, source: RagIngestSource): Promise<RagIngestResult>;
  query(userId: string, text: string, opts: RagQueryOpts): Promise<RagQueryResult>;
}

// ---------------------------------------------------------------------------
// Helpers (pure).
// ---------------------------------------------------------------------------

/** The text embedded + reranked for a chunk: its header then its content, as indexed. */
function embedInput(draft: ChunkDraft): string {
  return `${draft.header}\n${draft.content}`;
}

/** A snippet's token size, matching the chunker's `header + " " + content` estimate. */
function snippetTokens(hit: RagHit): number {
  return approxTokens(`${hit.header} ${hit.content}`);
}

/** Distinct speakers in transcript order (drops nulls) — seeds the chunk header. */
function distinctSpeakers(turns: TranscriptTurn[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.speaker !== null && !seen.has(turn.speaker)) {
      seen.add(turn.speaker);
      out.push(turn.speaker);
    }
  }
  return out;
}

/**
 * Keep the longest leading run of snippets whose cumulative tokens stay within
 * `budget` (adr §8: retrieval shrinks, never delays). Token counts are
 * non-negative so prefix sums are monotonic — the leading run IS the maximal set
 * that fits, i.e. dropping trailing snippets until Σ ≤ budget. A lone snippet
 * bigger than the whole budget yields an empty list (the budget is a hard law).
 */
function trimToBudget(snippets: RagHit[], budget: number): RagHit[] {
  const kept: RagHit[] = [];
  let acc = 0;
  for (const snippet of snippets) {
    const tokens = snippetTokens(snippet);
    if (acc + tokens > budget) break;
    kept.push(snippet);
    acc += tokens;
  }
  return kept;
}

/** Chunk one ingest source into drafts + its store-side {@link RagSource} ref. */
function chunkSource(
  chunker: Chunker,
  source: RagIngestSource,
  config: RagConfig,
): { drafts: ChunkDraft[]; ragSource: RagSource } {
  if (source.kind === "context_doc") {
    const meta: SourceMeta = { title: source.title };
    return {
      drafts: chunker.chunkDoc(source.content, meta, config),
      ragSource: { kind: "context_doc", contextDocId: source.contextDocId },
    };
  }
  const speakers = distinctSpeakers(source.turns);
  const meta: SourceMeta = {
    title: source.title,
    ...(source.date !== undefined ? { date: source.date } : {}),
    ...(speakers.length > 0 ? { speakers } : {}),
  };
  return {
    drafts: chunker.chunkTranscript(source.turns, meta, config),
    ragSource: { kind: "meeting", meetingId: source.meetingId },
  };
}

// ---------------------------------------------------------------------------
// Service factory.
// ---------------------------------------------------------------------------

/** Build the {@link RagService} over explicit ports (pure — no env, no I/O of its own). */
export function createRagService(deps: RagServiceDeps): RagService {
  const { chunker, embedder, store, reranker } = deps;
  const config = deps.config ?? ragConfig;
  const logger = deps.logger;

  return {
    async ingest(userId, sourceInput) {
      const source = ragIngestSourceSchema.parse(sourceInput);
      const { drafts, ragSource } = chunkSource(chunker, source, config);

      // Empty source → still replace with [] so a doc emptied/deleted upstream
      // clears its stale chunks (idempotent). No embed call on nothing.
      if (drafts.length === 0) {
        await store.replaceSource(userId, ragSource, []);
        logger?.info({ user_id: userId, kind: source.kind, chunks: 0 }, "rag.ingest");
        return { chunks: 0 };
      }

      // One document embed; the adapter batches internally by `embedBatchSize`.
      const { vectors, model, dims, usage } = await embedder.embed(
        drafts.map(embedInput),
        { kind: "document", userId },
      );
      if (vectors.length !== drafts.length) {
        throw RagError.embedderFailed(
          `embedder returned ${String(vectors.length)} vectors for ${String(drafts.length)} chunks`,
        );
      }

      const chunks: EmbeddedChunk[] = drafts.map((draft, i) => ({
        ...draft,
        embedding: vectors[i] ?? [],
        model,
        dims,
      }));
      await store.replaceSource(userId, ragSource, chunks);

      logger?.info(
        {
          user_id: userId,
          kind: source.kind,
          chunks: chunks.length,
          embed_tokens: usage.tokens,
        },
        "rag.ingest",
      );
      return { chunks: chunks.length };
    },

    async query(userId, text, opts) {
      // 1. Embed the query — single unbatched call, cheaper/faster `query` model.
      const embed = await embedder.embed([text], { kind: "query", userId });
      const vector = embed.vectors[0] ?? [];

      // 2. Hybrid search — pull `candidatesPerLeg` candidates for fusion headroom.
      const candidates = await store.search(userId, {
        vector,
        text,
        model: embed.model,
        k: config.candidatesPerLeg,
      });

      // 3. Tier-gated rerank. LIVE NEVER reranks (adr §5, architectural law); a
      //    deliberate query with no reranker configured falls through cleanly.
      const tierK = opts.tier === "live" ? config.kLive : config.kDeliberate;
      const reranked =
        opts.tier === "deliberate" && reranker
          ? await reranker.rerank(text, candidates, config.kDeliberate)
          : candidates;

      // 4. Trim to the tier/override count, then to the token budget.
      const finalK = opts.k ?? tierK;
      const budget = opts.tokenBudget ?? config.defaultTokenBudgetTokens;
      const snippets = trimToBudget(reranked.slice(0, finalK), budget);

      const usage: RagUsage = {
        embedTokens: embed.usage.tokens,
        candidatesRetrieved: candidates.length,
        snippetsReturned: snippets.length,
      };
      logger?.info(
        {
          user_id: userId,
          tier: opts.tier,
          candidates: candidates.length,
          returned: snippets.length,
          embed_tokens: embed.usage.tokens,
        },
        "rag.query",
      );
      return { snippets, usage };
    },
  };
}
