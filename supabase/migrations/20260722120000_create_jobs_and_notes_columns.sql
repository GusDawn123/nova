-- Migration: create `public.jobs` — the durable background-job queue that drives
-- post-call notes generation (kind='generate_notes') — and expand `public.meetings`
-- with the notes read-model columns. Phase 5 data foundation
-- (docs/DESIGN/notes-pipeline.md §Data model, docs/DECISIONS/adr-0006-notes-pipeline.md).
--
-- Ordering (RULES §4.7): applies after create_meetings (20260719215139), create_profiles
-- (20260719215138), and expand_meetings_transcripts_for_rag (20260721120100) — `jobs`
-- FKs both parents, and the meetings expand adds to a table those touched. Expand-only:
-- every meetings column is nullable or defaulted, so old code is unaffected (RULES §4.1).
--
-- `jobs` is service-role/pool-only — RLS ENABLED with ZERO policies (the
-- `deletion_requests` posture): anon/authenticated are locked out entirely, the server
-- adapter + worker reach it through the service_role (which bypasses RLS). Execution
-- state lives here (status/attempts/lease/backoff/dead-letter, one ACTIVE job per
-- (kind, meeting) via a partial unique index; completed/dead rows are history — a
-- regenerate is a fresh row). The product reads the denormalized `meetings.notes_status`
-- without joining jobs (adr-0006 §2).
--
-- PURGE-WORKER CONTRACT (scripts/purge/, extends the deletion_requests §note): `jobs`
-- references public.meetings(id) AND public.profiles(id) with NO ACTION (the FK default),
-- so to erase a user the worker MUST hard-delete this user's `jobs` rows BEFORE their
-- `meetings` rows (and before the profile / auth.users row) — otherwise the meetings
-- delete fails on the jobs FK. Full order now:
--   transcripts -> chunks/embeddings -> jobs -> meetings -> context_docs
--     -> deletion_requests -> auth.users.
-- (The ARCHITECTURE FK-order note is updated in Phase 5 Task 6 when the purge job lands.)
--
-- Reverse:
--   drop table if exists public.jobs;
--   alter table public.meetings drop constraint if exists meetings_notes_status_check;
--   alter table public.meetings drop column if exists notes;
--   alter table public.meetings drop column if exists notes_status;
--   alter table public.meetings drop column if exists notes_generated_at;
--   alter table public.meetings drop column if exists follow_up;
-- (reversal belongs in a future contract-step migration, never by editing this file.)

-- ---------------------------------------------------------------------------------
-- public.jobs — the durable queue. One row per (kind, meeting) generation attempt-set;
-- claimed with `FOR UPDATE SKIP LOCKED` (Task 2), leased, retried with backoff.
-- ---------------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid (),
  -- The job kind. Single-valued today; the CHECK keeps the column a closed set so a
  -- second kind is a deliberate migration, not a typo.
  kind text not null check (kind in ('generate_notes')),
  -- Parents are NO ACTION (the FK default): a job never cascades a meeting/profile away;
  -- the purge worker removes jobs first (see PURGE-WORKER CONTRACT above).
  meeting_id uuid not null references public.meetings (id),
  user_id uuid not null references public.profiles (id),
  -- Execution state (adr-0006 §3): queued -> processing -> completed | dead. Note this
  -- is the JOB lifecycle; the product-facing read model is meetings.notes_status.
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'completed', 'dead')
  ),
  attempts int not null default 0,
  max_attempts int not null default 5,
  -- Delayed retry: jittered exponential backoff lands the next eligible run here.
  run_at timestamptz not null default now(),
  -- The lease: which worker holds this row and since when (reaper requeues on expiry).
  locked_at timestamptz,
  locked_by text,
  last_error text,
  -- Failed generations keep the raw model text HERE (text) — malformed JSON lives on
  -- the job, never in meetings.notes (jsonb), so it stays unrepresentable there.
  raw_output text,
  -- Per-attempt token usage — the Phase 6 metering seam (router Meter port output).
  usage jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One ACTIVE job per (kind, meeting): a partial unique index over the live statuses.
-- completed/dead rows are excluded, so history is preserved and a regenerate inserts a
-- fresh row. Both enqueue paths (eager + sweep) are idempotent under this index.
create unique index jobs_active_uniq
  on public.jobs (kind, meeting_id)
  where status in ('queued', 'processing');

-- The claim scan: eligible queued rows by run_at. Partial keeps it to the ready backlog.
create index jobs_claim_idx
  on public.jobs (run_at)
  where status = 'queued';

-- The reap scan: in-flight rows by lease age (expired processing rows → requeue|dead).
create index jobs_reap_idx
  on public.jobs (locked_at)
  where status = 'processing';

-- RLS ships in the SAME migration as the table (RULES §4.9): no window unprotected.
alter table public.jobs enable row level security;

-- No policies on purpose — the `deletion_requests` posture: with RLS enabled and zero
-- policies, anon/authenticated are locked out entirely, while service_role bypasses RLS.
-- The queue is strictly server-side; users never read or write it directly.
--
-- Grants ship with the table (new public tables are NOT auto-exposed to the Data API
-- roles under this stack's default, config.toml [api]). Grant ONLY service_role —
-- anon/authenticated get nothing, reinforcing the lockout.
grant select, insert, update, delete on public.jobs to service_role;

-- ---------------------------------------------------------------------------------
-- public.meetings — notes read-model columns (expand-only, nullable/defaulted).
-- ---------------------------------------------------------------------------------
-- notes: ONLY ever a meetingNotesSchema-valid object (the output ladder guarantees it).
alter table public.meetings add column notes jsonb;
-- Denormalized generation state the product reads without joining jobs. Named CHECK so
-- the constraint is explicit in review + assertable in the isolation test.
alter table public.meetings
  add column notes_status text not null default 'none'
    constraint meetings_notes_status_check check (
      notes_status in ('none', 'queued', 'processing', 'completed', 'failed')
    );
alter table public.meetings add column notes_generated_at timestamptz;
-- Latest follow-up draft `{tone, subject, body, generated_at}` (Task 5 writes it).
alter table public.meetings add column follow_up jsonb;
