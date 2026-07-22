-- Migration: create `public.usage_events` — the append-only usage/billing ledger
-- (every metered vendor call: llm tokens, stt seconds, embedding tokens, rerank
-- requests) — and expand `public.profiles` with the subscription `plan` column.
-- Phase 6 metering foundation (docs/DESIGN/metering.md §Data model,
-- docs/DECISIONS/adr-0007-metering.md §1/§4).
--
-- Ordering (RULES §4.7): applies after create_profiles (20260719215138) and
-- create_meetings (20260719215139) — usage_events FKs both — and after
-- create_jobs_and_notes_columns (20260722120000), so this timestamp sorts last.
-- Expand-only: usage_events is new and profiles.plan is defaulted, so old code is
-- unaffected (RULES §4.1).
--
-- APPEND-ONLY LEDGER — NO deleted_at (adr-0007 §1 EXPLICIT RULES §3 EXCEPTION):
-- RULES §3's soft-delete law governs user-managed data; a billing ledger is
-- immutable history, not user-managed, so it carries no `deleted_at`. Rows are
-- never updated or soft-deleted by application code; the compliance purge worker
-- hard-deletes them (see PURGE-WORKER CONTRACT below). This deviation is sanctioned
-- solely by adr-0007 §1.
--
-- RLS posture (adr-0007 §1): users may READ their own bar tab (usage_events_select_own
-- for `authenticated`), but NO write policy exists for `authenticated` — the metering
-- service writes exclusively through service_role (which bypasses RLS). Grants match:
-- authenticated gets SELECT only; service_role gets the full set.
--
-- PURGE-WORKER CONTRACT (scripts/purge/, extends the jobs/deletion_requests notes):
-- usage_events references public.profiles(id) AND public.meetings(id) with NO ACTION
-- (the FK default), so to erase a user the worker MUST hard-delete this user's
-- `usage_events` rows BEFORE their `meetings` and `profiles` rows — otherwise the
-- parent deletes fail on the usage_events FK. usage_events purges FIRST in the chain:
--   usage_events -> transcripts -> chunks/embeddings -> jobs -> meetings
--     -> context_docs -> deletion_requests -> auth.users.
--
-- Reverse:
--   drop table if exists public.usage_events;
--   alter table public.profiles drop constraint if exists profiles_plan_check;
--   alter table public.profiles drop column if exists plan;
-- (reversal belongs in a future contract-step migration, never by editing this file.)

-- ---------------------------------------------------------------------------------
-- public.usage_events — one row per metered vendor call. Amounts are the source of
-- truth (tokens/seconds/requests, unit implied by `kind`); `cost_estimate_usd` is a
-- config-priced advisory stamped at write time (adr-0007 §1). Append-only.
-- ---------------------------------------------------------------------------------
create table public.usage_events (
  id uuid primary key default gen_random_uuid (),
  -- Attribution. Parents are NO ACTION (the FK default): a usage row never cascades a
  -- meeting/profile away; the purge worker removes usage_events first (see contract).
  user_id uuid not null references public.profiles (id),
  -- meeting_id is nullable: notes/embedding work is meeting-scoped, but some metered
  -- calls (e.g. follow-up over a user's memory) have no single meeting.
  meeting_id uuid references public.meetings (id),
  -- The vendor billed (e.g. 'openai','google','assemblyai','deepgram','voyage').
  vendor text not null,
  -- The metered unit family. Closed set — a new kind is a deliberate migration.
  kind text not null check (
    kind in ('llm_tokens', 'stt_seconds', 'embedding_tokens', 'rerank_requests')
  ),
  -- The billed amount, unit implied by `kind` (tokens | seconds | requests). Facts,
  -- not estimates — quotas run on these.
  amount numeric not null,
  -- LLM input/output token split (null for non-llm kinds).
  input_amount numeric,
  output_amount numeric,
  -- The model priced against, where one applies (null otherwise).
  model text,
  -- Advisory config-priced estimate (adr-0007 §1/§5): the kill-switch runs on this,
  -- never blocks a call, defaults to 0 so an unknown price can't break a write.
  cost_estimate_usd numeric not null default 0,
  created_at timestamptz not null default now()
  -- NO deleted_at: append-only billing ledger (adr-0007 §1 exception; see header).
);

-- Period sums per user (usedInPeriod → quota): (user_id, created_at) covers the
-- `where user_id = $1 and kind = $2 and created_at >= $3` range scan.
create index usage_events_user_created_idx
  on public.usage_events (user_id, created_at);

-- Global daily sum (spendToday → kill-switch): (created_at) covers the
-- `where created_at >= $1` scan across all users.
create index usage_events_created_idx
  on public.usage_events (created_at);

-- RLS ships in the SAME migration as the table (RULES §4.9): no window unprotected.
alter table public.usage_events enable row level security;

-- Users may read their OWN usage (their bar tab); anon gets nothing. Ownership-only
-- predicate, no joins. There is NO insert/update/delete policy on purpose — writes
-- are service-role-only (service_role bypasses RLS), so `authenticated` can never
-- forge or alter a billing row.
create policy usage_events_select_own
  on public.usage_events
  for select
  to authenticated
  using (user_id = auth.uid ());

-- Grants ship with the table (new public tables are NOT auto-exposed to the Data API
-- roles under this stack's default, config.toml [api]). authenticated gets SELECT
-- ONLY (to exercise select_own); service_role (bypasses RLS) gets the full set for
-- the metering writer and the purge job.
grant select on public.usage_events to authenticated;
grant select, insert, update, delete on public.usage_events to service_role;

-- ---------------------------------------------------------------------------------
-- public.profiles — subscription plan column (expand-only, defaulted). Drives the
-- per-user quota tier (adr-0007 §4). Named CHECK so it is explicit in review and
-- assertable in the posture test.
-- ---------------------------------------------------------------------------------
alter table public.profiles
  add column plan text not null default 'free'
    constraint profiles_plan_check check (plan in ('free', 'pro'));
