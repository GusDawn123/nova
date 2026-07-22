-- Migration: expand `public.meetings` and `public.transcripts` for RAG indexing
-- (Phase 4). Expand-only — every added column is nullable, no backfill, old code
-- unaffected (RULES §4.1). `meetings.ended_at` / `indexed_at` drive the background
-- sweeper that chunks + embeds a finished call; `transcripts.speaker` / `ts_ms`
-- carry the diarization + timing the STT gateway already produces so retrieval and
-- chunk headers can attribute turns.
--
-- Ordering (RULES §4.7): applies after create_meetings (20260719215139) and
-- create_transcripts (20260719215140).
--
-- No RLS change: the added columns are covered by the existing ownership policies on
-- both tables (predicates are `user_id`-based, column-agnostic). No isolation test
-- needed for a nullable-column expand (RULES §4.9 applies to new tables / policy
-- changes; policies are untouched here).
--
-- Reverse:
--   drop index if exists public.meetings_unindexed_idx;
--   alter table public.meetings drop column if exists ended_at;
--   alter table public.meetings drop column if exists indexed_at;
--   alter table public.transcripts drop column if exists speaker;
--   alter table public.transcripts drop column if exists ts_ms;
-- (reversal belongs in a future contract-step migration, never by editing this file.)

-- meetings: when the call ended, and when the RAG sweeper finished indexing it.
alter table public.meetings add column ended_at timestamptz;
alter table public.meetings add column indexed_at timestamptz;

-- The sweeper's scan: finished-but-not-yet-indexed, live meetings only. Partial
-- index keeps it tiny (only the backlog rows) and lets the sweeper poll cheaply.
create index meetings_unindexed_idx
  on public.meetings (ended_at)
  where ended_at is not null and indexed_at is null and deleted_at is null;

-- transcripts: diarized speaker label and turn start offset (ms into the call).
-- Nullable — historical rows predate diarization/timing (expand-only).
alter table public.transcripts add column speaker text;
alter table public.transcripts add column ts_ms bigint;
