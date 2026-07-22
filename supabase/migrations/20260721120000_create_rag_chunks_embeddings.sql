-- Migration: create the RAG storage tables — `public.chunks` (retrievable text
-- units carved from a context_doc OR a meeting) and `public.embeddings` (their
-- vector representations). This is the Phase 4 data foundation for per-user RAG
-- memory (docs/DESIGN/rag-memory.md, docs/DECISIONS/adr-0005-rag-memory.md).
--
-- Ordering (RULES §4.7): applies after create_profiles (FK to public.profiles),
-- create_meetings, and create_context_docs (chunks FK both parents) — and after
-- enforce_transcript_parentage, whose parentage EXISTS pattern the write policies
-- here deliberately mirror.
--
-- Policy form note: these are HOT read/write tables (every retrieval + ingest hits
-- them), so the write/read predicates use the initPlan-cached `(select auth.uid())`
-- form — Postgres evaluates the scalar subquery ONCE per statement instead of
-- per-row (unlike the older tables' bare `auth.uid()`). The parentage EXISTS checks
-- follow the same shape proven in enforce_transcript_parentage.
--
-- Reverse:
--   drop table if exists public.embeddings;   -- FK child of chunks; drop first
--   drop table if exists public.chunks;
--   -- the `vector` extension is intentionally left installed (shared infra).
-- (reversal belongs in a future contract-step migration, never by editing this file.)

-- pgvector lives in the dedicated `extensions` schema (Supabase house convention),
-- never in `public`. Idempotent so the shadow replay is clean.
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------------
-- public.chunks — one retrievable text unit, parented to EXACTLY ONE source.
-- ---------------------------------------------------------------------------------
create table public.chunks (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.profiles (id),
  -- Exactly one parent: a chunk comes from a context_doc XOR a meeting. The CHECK
  -- below (`<>`, i.e. XOR on the two null-tests) enforces exactly-one-set.
  context_doc_id uuid references public.context_docs (id),
  meeting_id uuid references public.meetings (id),
  content text not null,
  -- Section/heading breadcrumb prepended to the chunk for retrieval context; may be
  -- empty but never null (keeps the fts expression total).
  header text not null default '',
  chunk_index int not null,
  token_count int not null,
  -- Lexical half of hybrid retrieval (Task 3): a generated tsvector over the
  -- header + content, kept in sync by Postgres itself (STORED). English config.
  fts tsvector generated always as (
    to_tsvector('english', header || ' ' || content)
  ) stored,
  created_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); reads filter
  -- `deleted_at is null`.
  deleted_at timestamptz,
  -- Exactly-one-parent invariant: `(a is null) <> (b is null)` is true iff exactly
  -- one of the two is non-null.
  constraint chunks_one_parent check ((context_doc_id is null) <> (meeting_id is null))
);

-- Owner-scoped reads (all RAG queries are per-user) hit user_id on every query.
create index chunks_user_id_idx on public.chunks (user_id);
-- Lexical retrieval scans the tsvector.
create index chunks_fts_idx on public.chunks using gin (fts);
-- Parent lookups (re-chunk / cascade on a doc or meeting) and the parentage EXISTS.
create index chunks_context_doc_id_idx on public.chunks (context_doc_id);
create index chunks_meeting_id_idx on public.chunks (meeting_id);

-- RLS ships in the SAME migration as the table (RULES §4.9).
alter table public.chunks enable row level security;

-- SELECT: flat ownership (`user_id` is the chunk's own owner). initPlan-cached form.
--
-- No DELETE policy on purpose: users soft-delete via UPDATE of deleted_at; hard
-- deletes are service-role-only (RULES §3 soft-delete law).
create policy chunks_select_own
  on public.chunks
  for select
  to authenticated
  using (user_id = (select auth.uid ()));

-- INSERT: own the chunk row AND own the LIVE parent it points at (context_doc or
-- meeting, whichever is set). Mirrors the transcript-parentage EXISTS guard so a
-- chunk can never be parented onto another user's — or a soft-deleted — source.
create policy chunks_insert_own
  on public.chunks
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid ())
    and (
      exists (
        select 1
        from public.context_docs d
        where d.id = context_doc_id
          and d.user_id = (select auth.uid ())
          and d.deleted_at is null
      )
      or exists (
        select 1
        from public.meetings m
        where m.id = meeting_id
          and m.user_id = (select auth.uid ())
          and m.deleted_at is null
      )
    )
  );

-- UPDATE: `using` is a flat ownership check (which rows the writer may target); the
-- with-check re-asserts the parentage guard so a chunk can never be re-parented onto
-- another user's or a dead source.
create policy chunks_update_own
  on public.chunks
  for update
  to authenticated
  using (user_id = (select auth.uid ()))
  with check (
    user_id = (select auth.uid ())
    and (
      exists (
        select 1
        from public.context_docs d
        where d.id = context_doc_id
          and d.user_id = (select auth.uid ())
          and d.deleted_at is null
      )
      or exists (
        select 1
        from public.meetings m
        where m.id = meeting_id
          and m.user_id = (select auth.uid ())
          and m.deleted_at is null
      )
    )
  );

-- Grants mirror context_docs: authenticated gets select/insert/update (no delete —
-- soft-delete-only); service_role (bypasses RLS) gets the full set for the server
-- adapter / purge job.
grant select, insert, update on public.chunks to authenticated;
grant select, insert, update, delete on public.chunks to service_role;

-- ---------------------------------------------------------------------------------
-- public.embeddings — a chunk's vector under a named model. `(chunk_id, model)`
-- unique so a chunk can carry one vector per model (incremental re-embed on a model
-- swap, RULES §5) without duplicates.
-- ---------------------------------------------------------------------------------
create table public.embeddings (
  id uuid primary key default gen_random_uuid (),
  chunk_id uuid not null references public.chunks (id),
  -- Denormalized owner (like transcripts.user_id) so the RLS SELECT predicate stays
  -- a flat `user_id = auth.uid()` with no join into chunks.
  user_id uuid not null references public.profiles (id),
  model text not null,
  dims int not null,
  -- halfvec (2-byte floats) halves storage vs vector for a negligible recall cost at
  -- 1024 dims; lives in the `extensions` schema alongside the operator classes.
  embedding extensions.halfvec (1024) not null,
  created_at timestamptz not null default now(),
  -- Soft delete (RULES §3).
  deleted_at timestamptz,
  unique (chunk_id, model)
);

-- ANN retrieval index: HNSW over cosine distance on the halfvec column. m /
-- ef_construction are the standard build-quality knobs; cosine matches the
-- normalized-embedding retrieval in Task 3.
create index embeddings_embedding_idx
  on public.embeddings
  using hnsw (embedding extensions.halfvec_cosine_ops)
  with (m = 16, ef_construction = 128);
-- Owner-scoped reads hit user_id.
create index embeddings_user_id_idx on public.embeddings (user_id);

-- RLS ships in the SAME migration as the table (RULES §4.9).
alter table public.embeddings enable row level security;

-- SELECT: flat ownership on the denormalized user_id. initPlan-cached form.
--
-- No DELETE policy on purpose (soft-delete law, as above).
create policy embeddings_select_own
  on public.embeddings
  for select
  to authenticated
  using (user_id = (select auth.uid ()));

-- INSERT: own the embedding row AND own the LIVE parent chunk it points at. Same
-- parentage EXISTS shape as chunks/transcripts.
create policy embeddings_insert_own
  on public.embeddings
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid ())
    and exists (
      select 1
      from public.chunks c
      where c.id = chunk_id
        and c.user_id = (select auth.uid ())
        and c.deleted_at is null
    )
  );

-- UPDATE: flat ownership `using`, parentage guard re-asserted in with-check.
create policy embeddings_update_own
  on public.embeddings
  for update
  to authenticated
  using (user_id = (select auth.uid ()))
  with check (
    user_id = (select auth.uid ())
    and exists (
      select 1
      from public.chunks c
      where c.id = chunk_id
        and c.user_id = (select auth.uid ())
        and c.deleted_at is null
    )
  );

-- Grants mirror context_docs / chunks.
grant select, insert, update on public.embeddings to authenticated;
grant select, insert, update, delete on public.embeddings to service_role;
