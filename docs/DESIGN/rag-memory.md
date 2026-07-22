# RAG memory — design (Phase 4)

The per-user memory that grounds Nova's suggestions and notes: uploaded context docs
plus every finished call, chunked, embedded, and retrievable in one fast, strictly
user-scoped query. This document is the architecture; the binding decisions live in
`DECISIONS/adr-0005-rag-memory.md`. RULES §5 governs: four swappable ports, pgvector
is an adapter, `RagService.query(userId, text, opts)` / `.ingest(...)` is the only
public surface.

## Shape of the problem

Multi-tenant with a very particular skew: each user's corpus is small (hundreds to
low-tens-of-thousands of chunks) while the table across all users grows to millions.
Every query is scoped to exactly one `user_id`. Two latency tiers exist:

- **live** — retrieval feeding an in-call suggestion. Budget: p95 < 300ms for the
  whole `RagService.query` call (embed + search), because Phase 7 spends the rest of
  its budget on the LLM. No remote reranker here, ever.
- **deliberate** — post-call notes, on-demand Q&A. 1–2s is fine; quality wins.

This skew drives the whole design: within one user's few thousand rows, retrieval is
cheap no matter what; the danger is the classic multi-tenant filtered-ANN trap where
a global HNSW graph walk returns mostly *other users'* neighbors and post-filtering
starves the result set (recall collapse, not just latency). Mitigations below.

## Module map

```
modules/rag/
  ports.ts        # Chunker, Embedder, VectorStore, Reranker + RagService types
  chunker.ts      # pure: turn-window chunking (transcripts), paragraph chunking (docs)
  service.ts      # RagService: ingest + query pipelines, token budget, typed errors
  indexer.ts      # call-completion sweeper (ended_at set, indexed_at null → ingest)
  config.ts       # tunables in one place (chunk sizes, k, rrf_k, sweep interval, timeouts)
  adapters/
    voyage.ts     # Embedder (+ Reranker for deliberate tier) — Voyage AI REST, zod-parsed
    pgvector.ts   # VectorStore — direct pg Pool, hybrid RRF SQL, explicit user_id filter
  testing/        # deterministic mock embedder/store for behavior tests
```

## Data model (expand-only migrations)

- `chunks` — the retrieval unit. `user_id` (FK profiles), exactly one of
  `context_doc_id` / `meeting_id` set (CHECK-enforced two-way parentage), `content`,
  `header` (contextual metadata line, see Chunking), `chunk_index`, `token_count`,
  generated stored `fts tsvector` over `header || content`, soft delete. GIN index on
  `fts`, btree on `user_id` and on each parent id.
- `embeddings` — one row per (chunk, model). `chunk_id` FK, denormalized `user_id`,
  `model` + `dims` columns (RULES §5 versioning — a model swap re-embeds side-by-side
  and cuts over, never big-bangs), `embedding halfvec(1024)`, unique `(chunk_id,
  model)`, soft delete. HNSW index (`halfvec_cosine_ops`), btree on `user_id`.
- `meetings` gains `ended_at` (call finished) and `indexed_at` (memory caught up) —
  the freshness contract is the gap between them.
- `transcripts` gains nullable `speaker` and `ts_ms` so the live session can persist
  diarized finals worth chunking by turn.

RLS ships with both new tables (select/insert/update-own for `authenticated`), same
posture as Phase 1 tables. But the **hot path does not rely on RLS**: the server is
trusted, so the pgvector adapter always applies an explicit `WHERE user_id = $1`.
RLS is defense-in-depth for any future client-direct path, and the isolation bar is
still proven the hard way — user B's JWT against user A's chunks/embeddings rows.

## Retrieval pipeline

**Hybrid, fused in one SQL round trip.** Pure vector search misses exact tokens
(names, prices, IDs — precisely what a call copilot gets asked about); adding a
full-text leg lifts practice-reported precision from roughly 62% to 84%. Two CTEs —
semantic (cosine over HNSW) and full-text (`websearch_to_tsquery` + `ts_rank_cd`) —
each user-scoped and limited to ~30 candidates, joined with Reciprocal Rank Fusion
(`1/(rrf_k + rank)`, rrf_k≈50). One round trip, no second service.

**Multi-tenant recall safety:** btree on `user_id` beside the HNSW index, and
`SET LOCAL hnsw.iterative_scan = relaxed_order` on the semantic leg (pgvector 0.8+)
so the graph walk keeps going until it finds *this user's* neighbors instead of
returning a starved, post-filtered set. `hnsw.max_scan_tuples` stays default as the
runaway bound. If a future whale tenant degrades this, the escape hatches are (in
order): partial index for that tenant, then native partitioning — both adapter-local.

**Reranking is tier-gated.** `live` never reranks (remote rerankers cost 100–600ms —
the whole budget). `deliberate` reranks top-30 → top-k via Voyage rerank (same API
key), where the measured quality lift is worth the latency. The Reranker port
defaults to identity, so a keyless deploy still works.

**Query path** (`RagService.query`):
1. embed the query — `voyage-4-lite`, `input_type: "query"`, unbatched (batching a
   hot-path query with anything else measurably adds latency)
2. hybrid search — one SQL round trip, explicit `user_id`, current model only
3. tier-gated rerank
4. trim to `opts.tokenBudget` (callers enforce the live-pipeline law: RAG can shrink,
   never delay, the first token) and return snippets with `header`, `content`,
   score, and source refs (`meeting_id` / `context_doc_id`)

Failures are typed (`RAG_NOT_CONFIGURED`, `EMBEDDER_FAILED`, `STORE_FAILED`) — the
caller decides whether to degrade (Phase 7's live path will drop RAG and proceed;
this service never silently returns wrong-user or stale-model results).

## Ingestion pipeline

`RagService.ingest(userId, source)` where source is a context doc or a finished
meeting. Steps: load text (doc content, or the meeting's transcript rows ordered by
`ts_ms`) → chunk → embed as `input_type: "document"` with `voyage-4` in batched
array calls → transactional upsert. Re-ingest is idempotent: soft-delete the
source's existing chunks, insert fresh — a crashed or repeated run converges.

**Chunking** (pure, deterministic, its own unit tests):
- transcripts: consecutive diarized turns packed into ~400-token windows (cap 512),
  one-turn overlap between windows — turn boundaries are semantic boundaries in
  conversation, so we never split mid-turn unless a single turn overflows the cap
- docs: paragraph-aware ~400-token windows, ~15% overlap
- every chunk gets a `header` — `Meeting: {title} ({date}) — {speakers}` or
  `Doc: {title}` — prepended for both embedding and full-text indexing. This is the
  zero-cost version of contextual retrieval (metadata we already have, no LLM call);
  LLM-generated contextual headers are a logged opener, applied as an async
  enrichment pass so they can never gate freshness.

**Auto-indexing on call completion.** Phase 3 streamed transcripts to the phone and
dropped them; Phase 4 closes the loop:
1. `LiveSession` persists final transcript events (content, speaker, ts_ms) as they
   arrive — writes happen off the relay path and never block or delay socket sends
2. on session close, the meeting's `ended_at` is set
3. a sweeper (`indexer.ts`, ~20s interval) picks meetings with `ended_at` set and
   `indexed_at` null, runs `ingest`, then stamps `indexed_at`

Marker-and-sweep instead of an in-process queue. Only the **sweep half** is crash-safe
by construction: an already-ENDED but unindexed meeting (`ended_at` set, `indexed_at`
null) survives a restart — it is simply found on the next sweep, and idempotent ingest
makes double-processing harmless. The **marker half is NOT crash-safe**: `ended_at` is
stamped *only* by session disposal, so a crash mid-call — before disposal runs — leaves
`ended_at` null forever, and that call is never swept and never indexed; it is orphaned
from memory until a stale-call reaper exists. That reaper is a **Phase 5 opener**:
sweep-side, treat a meeting whose `started_at` is old AND `ended_at` is still null as
having ended (stamp `ended_at`) so the normal sweep then picks it up. Freshness bar
(queryable < 60s after call end) holds with 3x headroom at a 20s sweep. The durable
job-queue generalization arrives with Phase 5's notes pipeline; single-server
assumption is documented in `indexer.ts` (multi-instance needs claim semantics —
`FOR UPDATE SKIP LOCKED` — logged as a Phase 6 opener).

## Cost & latency at scale

- **Latency, per query (live tier):** query embed ~30–60ms (voyage-4-lite, small
  input) + hybrid SQL ~15–40ms at 10k-chunk corpora = comfortably inside the 300ms
  p95 bar, which the benchmark script proves with a printed number, not vibes. The
  adapter talks **direct Postgres (`pg` Pool)**, not PostgREST — the REST layer
  roughly triples p95 at scale and buys nothing on a trusted server. Phase 7 will
  additionally *prefetch* — a rolling background query during the call keeps a warm
  snippet cache so the moment-of-suggestion read is ~1ms — which is why RagService
  exposes plain fast primitives instead of baking in session state.
- **Cost, per user-call:** a 30-min call ≈ 5k words ≈ 7k tokens embedded once at
  $0.06/M (voyage-4) — fractions of a cent; query embeds at $0.02/M are noise. At
  10k users × daily calls this stays low-double-digit dollars/month — embedding cost
  does not shape this architecture; STT/LLM dwarf it.
- **Storage:** halfvec(1024) ≈ 2KB/vector + HNSW overhead ≈ 2–3x — ~1M chunks ≈
  single-digit GB, years of headroom on Supabase. Signals for outgrowing pgvector
  (~10M+ vectors, sub-20ms p99 demands, vacuum churn) are documented and far away;
  the VectorStore port is the exit door.
- **Usage recording:** every Voyage call logs structured usage (user_id, tokens) in
  the shape Phase 6's metering module will consume — no unmetered vendor paths.

## Edge cases held by design

- **No Voyage key** → `RAG_NOT_CONFIGURED` typed error; server boots fine; live
  sessions and ingest degrade explicitly, never crash (same posture as keyless STT).
- **Empty/tiny corpus** (new user) → query returns empty snippets, not an error.
- **Empty call** (no finals persisted) → sweeper stamps `indexed_at` with zero
  chunks; no retry loop on nothing.
- **Doc edited/deleted** → re-ingest soft-deletes old chunks; soft-deleted parents
  are excluded by ingestion and by both search legs (`deleted_at is null`
  everywhere). HNSW dead-tuple churn from heavy edit cycles is monitored via the
  benchmark's recall probes; `REINDEX CONCURRENTLY` is the documented remedy.
- **Embedding vendor down mid-ingest** → typed failure, `indexed_at` stays null,
  next sweep retries — eventual consistency with a visible marker, no lost calls.
- **Model migration** → new model's rows written beside the old under the same
  chunks (unique per (chunk_id, model)); queries pin the current model; cutover
  flips config after the shadow corpus completes; old rows are archived, not
  clobbered. Documents-before-queries ordering is the law (reversing it silently
  returns garbage).
- **Huge single document** → chunker caps per-source chunk count (config) with a
  typed `SOURCE_TOO_LARGE` beyond it — no unbounded embed bills from one upload.
- **Cross-tenant leakage** — the one unforgivable failure — is held three ways:
  explicit `user_id` predicate in every adapter query, RLS on the tables underneath,
  and a JWT-direct adversarial test that stays in CI forever.
