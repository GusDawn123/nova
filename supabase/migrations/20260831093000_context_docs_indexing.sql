-- Knowledge base: context_docs learns when its RAG chunks were last written.
--
-- EXPAND-only (RULES §4): one nullable column, no backfill needed — every
-- existing row is honestly "never indexed", which is exactly what null says.
-- The chunks themselves already carry context_doc_id (20260721120000); this
-- stamp is the sweep/read-side freshness fact, mirroring meetings.indexed_at.
--
-- Reverse: alter table public.context_docs drop column indexed_at;

alter table public.context_docs
  add column indexed_at timestamptz;

comment on column public.context_docs.indexed_at is
  'When this doc''s RAG chunks were last (re)written; null = not searchable yet.';
