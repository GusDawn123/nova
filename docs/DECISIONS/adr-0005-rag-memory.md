# ADR-0005 — RAG memory: vendor, storage, and retrieval decisions

Status: accepted (Phase 4). Companion to `docs/DESIGN/rag-memory.md`; RULES §5 is
the constitution (four ports, pgvector is an adapter, `RagService` is the only
surface). Decisions are numbered so later phases can cite them.

## 1. Embeddings vendor: Voyage AI, two-speed on one space

`voyage-4` for document/background indexing, `voyage-4-lite` for hot-path query
embedding, both at **1024 dimensions** (Matryoshka truncation), `input_type` set to
`document`/`query` respectively. The deciding property: the voyage-4 family shares
one embedding space, so we index with the higher-quality model and query with the
cheaper/faster one — no dual index, no re-embed. Voyage is also Anthropic's
recommended embeddings partner, benchmarks well on NA median latency, has 32k input
tokens, and batch pricing ($0.013–0.04/M) keeps auto-indexing every call cheap.
Post-MongoDB-acquisition the standalone API remains live and independently usable.
Fallback vendor if live latency disappoints: Cohere embed-v4 @1024 (fastest NA
median; no batch discount — that's why it's the fallback). Anthropic offers no
first-party embeddings API. New env: `VOYAGE_API_KEY` (optional — keyless deploys
get typed `RAG_NOT_CONFIGURED`, never a crash).

## 2. Storage: halfvec(1024), HNSW, model-versioned rows

`halfvec` (fp16) unconditionally — ~2x storage/build-time win at <1% recall cost.
HNSW (`m=16, ef_construction=128`), never IVFFlat (30x worse tail latency at equal
recall, retrain-on-write). `embeddings` rows carry `model` + `dims` (RULES §5); one
row per (chunk, model) so a migration runs shadow-corpus → verify → cut over —
**never** lazy re-embed-on-touch (mixed-model cosine fails silently), and always
documents-before-queries on cutover.

## 3. Multi-tenant recall safety: exploit the small-tenant skew

Per-user corpora are small; the global table is big. Defense stack for the filtered-
ANN recall trap: btree on `user_id` beside HNSW, `hnsw.iterative_scan =
relaxed_order` (SET LOCAL, pgvector 0.8+) on the semantic leg, default
`max_scan_tuples` as the runaway bound. Escalation path if a whale tenant appears:
per-tenant partial index, then native partitioning — all adapter-local, no port
change. Per-tenant partial indexes as a *general* strategy are rejected (index
explosion past ~100 tenants).

## 4. Hot path bypasses PostgREST and leans on explicit predicates, not RLS

The pgvector adapter uses a direct `pg` Pool (`SUPABASE_DB_URL`, optional env;
Supavisor-transaction-mode safe — no named prepared statements). PostgREST roughly
triples p95 at scale and adds nothing on a trusted server. Every query carries an
explicit `WHERE user_id = $1 AND deleted_at is null`. RLS still ships on `chunks`
and `embeddings` (defense-in-depth for any future client-direct path) and is
adversarially tested with user B's JWT, but the server's latency budget never pays
per-row policy evaluation.

## 5. Hybrid retrieval by default; reranking is tier-gated

Every search is hybrid: pgvector cosine leg + `tsvector`/`ts_rank_cd` full-text leg,
fused with RRF (rrf_k≈50, ~30 candidates/leg) in ONE SQL round trip. Full-text
catches the exact tokens (names, prices, IDs) embeddings blur. `ts_rank_cd` (not
true BM25) is accepted for now — ParadeDB/pg_textsearch is a logged upgrade if
keyword ranking underperforms. Reranking: `live` tier NEVER reranks (remote
rerankers cost 100–600ms — the entire budget); `deliberate` tier reranks top-30 via
Voyage rerank under the same API key. Reranker port defaults to identity.

## 6. Chunking: turn-windows with metadata headers, no LLM in the loop

Transcripts chunk by consecutive diarized turns packed to ~400 tokens (cap 512),
one-turn overlap; never split mid-turn unless one turn overflows. Docs chunk
paragraph-aware ~400 tokens, ~15% overlap. Every chunk gets a metadata header
(`Meeting: {title} ({date}) — {speakers}` / `Doc: {title}`) embedded AND
fts-indexed — the zero-cost core of contextual retrieval. LLM-generated contextual
headers (Anthropic's technique, ~49% retrieval-failure reduction with hybrid) are a
logged opener as an async enrichment pass — they must never gate freshness (~4–6s
per doc if done synchronously). Verbatim chunks beat summarized artifacts as the
retrieval substrate; we store what was said.

## 7. Freshness: marker-and-sweep, not a queue (yet)

Call completion sets `meetings.ended_at`; a ~20s sweeper ingests meetings where
`indexed_at` is null, then stamps it. Crash-safe by construction (restart → next
sweep finds the work; idempotent re-ingest converges), meets the <60s bar with 3x
headroom, zero queue infra. Phase 5's durable job queue generalizes this; the
single-instance assumption is documented in code, multi-instance claiming
(`FOR UPDATE SKIP LOCKED`) is a logged Phase 6 opener.

## 8. Latency posture inherits adr-0004's philosophy

Retrieval can shrink, never delay (live-pipeline law): `RagService.query` takes a
`tokenBudget` and trims; live-tier failures are typed so Phase 7 drops RAG and
proceeds rather than stalling a suggestion. The service stays a fast stateless
primitive — Phase 7's session prefetch cache (rolling background retrieval during
the call, ~1ms reads at suggestion time) composes on top; it does not live inside
this module. The p95 < 300ms bar is proven by a benchmark that prints numbers on a
seeded 10k-chunk corpus, in CI-runnable form.

## Known gaps / openers

- LLM contextual-header enrichment pass (async, post-freshness) — quality upsell.
- True BM25 (ParadeDB `pg_search` / `pg_textsearch`) if `ts_rank_cd` keyword
  ranking underperforms on real corpora.
- Multi-instance sweeper claiming; durable queue lands with Phase 5.
- Recall-drift monitoring (HNSW dead-tuple degradation under heavy doc-edit churn;
  pgvector #244) — periodic known-answer probes + `REINDEX CONCURRENTLY` runbook.
- Cohere embed-v4 fallback adapter if Voyage live latency disappoints in practice.
