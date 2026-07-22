import { Pool } from "pg";
import { z } from "zod";

import { ragConfig, type RagConfig } from "../config.js";
import { isRagError, RagError } from "../ports.js";
import type {
  EmbeddedChunk,
  RagHit,
  RagSource,
  VectorStore,
} from "../ports.js";

/**
 * pgvector {@link VectorStore} adapter (Phase 4) — the ONLY place the RAG hot
 * path talks to Postgres, over a direct `pg` Pool rather than PostgREST
 * (adr-0005 §4: PostgREST ~triples p95 and buys nothing on a trusted server).
 * Every leg of every query carries an explicit `user_id` predicate — tenant
 * isolation on this path is the WHERE clause, not RLS (RLS still ships on the
 * tables as defense-in-depth and is adversarially tested elsewhere). Soft-delete
 * only (RULES §3): a "replace" sets `deleted_at`, never DELETEs.
 *
 * Supavisor transaction-mode safe (adr §4): only UNNAMED prepared statements are
 * ever issued (`pg` names none unless you pass `name`), so pooled connections
 * never accumulate server-side statement state.
 *
 * Design source: `docs/DECISIONS/adr-0005-rag-memory.md` §§2,3,4,5.
 */

const PG_POOL_MAX = 10;
const PG_IDLE_TIMEOUT_MS = 30_000;

/** The config knobs the retrieval SQL reads (candidates/leg + the RRF constant). */
export type PgVectorConfig = Pick<RagConfig, "candidatesPerLeg" | "rrfK">;

// ---------------------------------------------------------------------------
// Row schemas (zod-parsed — the DB is a boundary too; RULES: parse every one).
// ---------------------------------------------------------------------------

/** `returning id` from the chunk bulk-insert (positionally aligned to input). */
const returnedChunkSchema = z.object({ id: z.string() });

/**
 * One hybrid-search result row. `score` arrives as a Postgres `numeric` (string
 * over the wire) — coerce it to a JS number at the boundary.
 */
const searchRowSchema = z.object({
  id: z.string(),
  content: z.string(),
  header: z.string(),
  context_doc_id: z.string().nullable(),
  meeting_id: z.string().nullable(),
  score: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Hybrid retrieval SQL (adr §5). Positional params documented per query.
// ---------------------------------------------------------------------------

/**
 * Hybrid RRF: semantic (cosine) + full-text legs fused in ONE round trip.
 * Params: $1 vec, $2 user_id, $3 model, $4 candidates/leg, $5 query text,
 * $6 rrf_k, $7 k. Both legs carry the explicit `user_id` predicate (adr §4) AND
 * the final join-back re-asserts it — `embeddings.user_id` is a denormalized
 * copy with no composite FK, so a mis-denormalized row must not be able to
 * surface another tenant's chunk.
 */
const HYBRID_SQL = `
with semantic as (
  select e.chunk_id,
    row_number() over (order by e.embedding <=> $1::halfvec) as rank_ix
  from embeddings e
  where e.user_id = $2 and e.model = $3 and e.deleted_at is null
  order by e.embedding <=> $1::halfvec
  limit $4
), full_text as (
  select c.id as chunk_id,
    row_number() over (
      order by ts_rank_cd(c.fts, websearch_to_tsquery('english', $5)) desc
    ) as rank_ix
  from chunks c
  where c.user_id = $2 and c.deleted_at is null
    and c.fts @@ websearch_to_tsquery('english', $5)
  limit $4
)
select c.id, c.content, c.header, c.context_doc_id, c.meeting_id,
  coalesce(1.0 / ($6 + s.rank_ix), 0) + coalesce(1.0 / ($6 + f.rank_ix), 0) as score
from semantic s
full outer join full_text f using (chunk_id)
join chunks c on c.id = coalesce(s.chunk_id, f.chunk_id)
where c.user_id = $2 and c.deleted_at is null
order by score desc
limit $7
`;

/**
 * Semantic-only variant used when the query text is empty/whitespace
 * (`websearch_to_tsquery('')` matches nothing, so the fts leg is skipped).
 * Params: $1 vec, $2 user_id, $3 model, $4 candidates, $5 rrf_k, $6 k.
 */
const SEMANTIC_SQL = `
with semantic as (
  select e.chunk_id,
    row_number() over (order by e.embedding <=> $1::halfvec) as rank_ix
  from embeddings e
  where e.user_id = $2 and e.model = $3 and e.deleted_at is null
  order by e.embedding <=> $1::halfvec
  limit $4
)
select c.id, c.content, c.header, c.context_doc_id, c.meeting_id,
  coalesce(1.0 / ($5 + s.rank_ix), 0) as score
from semantic s
join chunks c on c.id = s.chunk_id
where c.user_id = $2 and c.deleted_at is null
order by score desc
limit $6
`;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Serialize a vector as pgvector's text literal form `[v1,v2,...]`. */
function toHalfvecLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Map an unknown failure to a typed store error, preserving any RagError as-is. */
function asStoreError(err: unknown): RagError {
  if (isRagError(err)) return err;
  return RagError.storeFailed("pgvector: query failed", { cause: err });
}

// ---------------------------------------------------------------------------
// Store factory.
// ---------------------------------------------------------------------------

/** Construction options: a live pool + the retrieval knobs. */
export interface PgVectorStoreOptions {
  readonly pool: Pool;
  readonly config: PgVectorConfig;
}

/**
 * Build the {@link VectorStore} over an explicit pool. Pure of env — the
 * integration test injects its own pool at the local stack; production uses
 * {@link pgVectorStoreFromEnv}.
 */
export function createPgVectorStore(opts: PgVectorStoreOptions): VectorStore {
  const { pool, config } = opts;

  return {
    async replaceSource(
      userId: string,
      source: RagSource,
      chunks: EmbeddedChunk[],
    ): Promise<void> {
      const parentCol =
        source.kind === "context_doc" ? "context_doc_id" : "meeting_id";
      const parentId =
        source.kind === "context_doc" ? source.contextDocId : source.meetingId;
      const contextDocId =
        source.kind === "context_doc" ? source.contextDocId : null;
      const meetingId = source.kind === "meeting" ? source.meetingId : null;

      const client = await pool.connect();
      try {
        await client.query("begin");
        // halfvec type + the `<=>` operator live in the `extensions` schema.
        await client.query("set local search_path = public, extensions");

        // Soft-delete this source's live embeddings (via its chunks) THEN chunks.
        await client.query(
          `update embeddings set deleted_at = now()
           where user_id = $1 and deleted_at is null
             and chunk_id in (
               select id from chunks where user_id = $1 and ${parentCol} = $2
             )`,
          [userId, parentId],
        );
        await client.query(
          `update chunks set deleted_at = now()
           where user_id = $1 and ${parentCol} = $2 and deleted_at is null`,
          [userId, parentId],
        );

        if (chunks.length > 0) {
          // Bulk-insert chunks (multi-row VALUES), returning ids in row order.
          const chunkValues: unknown[] = [];
          const chunkRows = chunks.map((ch, i) => {
            const b = i * 7;
            chunkValues.push(
              userId,
              contextDocId,
              meetingId,
              ch.content,
              ch.header,
              ch.chunkIndex,
              ch.tokenCount,
            );
            return `(${[1, 2, 3, 4, 5, 6, 7]
              .map((o) => `$${String(b + o)}`)
              .join(", ")})`;
          });
          const inserted = await client.query(
            `insert into chunks
               (user_id, context_doc_id, meeting_id, content, header, chunk_index, token_count)
             values ${chunkRows.join(", ")}
             returning id`,
            chunkValues,
          );
          const ids = z.array(returnedChunkSchema).safeParse(inserted.rows);
          if (!ids.success || ids.data.length !== chunks.length) {
            throw RagError.storeFailed(
              "pgvector: chunk insert returned an unexpected id set",
              ids.success ? undefined : { cause: ids.error },
            );
          }

          // Bulk-insert embeddings; serialize each vector as a `$n::halfvec`.
          const embValues: unknown[] = [];
          const embRows = chunks.map((ch, i) => {
            const b = i * 5;
            embValues.push(
              ids.data[i]?.id,
              userId,
              ch.model,
              ch.dims,
              toHalfvecLiteral(ch.embedding),
            );
            return `($${String(b + 1)}, $${String(b + 2)}, $${String(b + 3)}, $${String(b + 4)}, $${String(b + 5)}::halfvec)`;
          });
          await client.query(
            `insert into embeddings (chunk_id, user_id, model, dims, embedding)
             values ${embRows.join(", ")}`,
            embValues,
          );
        }

        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw asStoreError(err);
      } finally {
        client.release();
      }
    },

    async search(
      userId: string,
      q: { vector: number[]; text: string; model: string; k: number },
    ): Promise<RagHit[]> {
      const vecLiteral = toHalfvecLiteral(q.vector);
      const text = q.text.trim();
      const hasFts = text.length > 0;

      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local search_path = public, extensions");
        // Small per-user corpus in a big global table → relaxed iterative scan
        // keeps filtered-ANN recall honest (adr §3). SET LOCAL = txn-scoped.
        await client.query("set local hnsw.iterative_scan = relaxed_order");

        const result = hasFts
          ? await client.query(HYBRID_SQL, [
              vecLiteral,
              userId,
              q.model,
              config.candidatesPerLeg,
              text,
              config.rrfK,
              q.k,
            ])
          : await client.query(SEMANTIC_SQL, [
              vecLiteral,
              userId,
              q.model,
              config.candidatesPerLeg,
              config.rrfK,
              q.k,
            ]);

        await client.query("commit");

        const parsed = z.array(searchRowSchema).safeParse(result.rows as unknown);
        if (!parsed.success) {
          throw RagError.storeFailed(
            `pgvector: unparseable search rows — ${parsed.error.message}`,
            { cause: parsed.error },
          );
        }
        return parsed.data.map((r) => ({
          chunkId: r.id,
          content: r.content,
          header: r.header,
          score: r.score,
          contextDocId: r.context_doc_id,
          meetingId: r.meeting_id,
        }));
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw asStoreError(err);
      } finally {
        client.release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Env factory (lazy pool, like db/client.ts).
// ---------------------------------------------------------------------------

/** Re-parsed at this boundary (RULES: parse every boundary), local to the adapter. */
const pgEnvSchema = z.object({ SUPABASE_DB_URL: z.string().url() });

/**
 * Build a pool from env. A missing/invalid `SUPABASE_DB_URL` throws
 * {@link RagError} `RAG_NOT_CONFIGURED` (adr §4) — like `db/client.ts`, only on a
 * path that genuinely needs the DB, never at boot. Pool sized per adr (max 10,
 * 30s idle). Exposed so tests can own + close their own pool.
 */
export function createPgPool(source: NodeJS.ProcessEnv = process.env): Pool {
  const parsed = pgEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw RagError.notConfigured(
      "pgvector store is not configured: set SUPABASE_DB_URL to use RAG storage.",
    );
  }
  return new Pool({
    connectionString: parsed.data.SUPABASE_DB_URL,
    max: PG_POOL_MAX,
    idleTimeoutMillis: PG_IDLE_TIMEOUT_MS,
  });
}

let cachedPool: Pool | undefined;

/**
 * Lazily build + memoise the pool and wrap it as a {@link VectorStore}. Throws
 * {@link RagError} `RAG_NOT_CONFIGURED` when `SUPABASE_DB_URL` is absent.
 */
export function pgVectorStoreFromEnv(
  source: NodeJS.ProcessEnv = process.env,
  config: PgVectorConfig = ragConfig,
): VectorStore {
  cachedPool ??= createPgPool(source);
  return createPgVectorStore({ pool: cachedPool, config });
}
