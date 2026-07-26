-- Migration: create `public.live_notes` — the running-notes PREVIEW accrued during
-- a live call (Phase 8, docs/DESIGN/live-notes.md §7).
--
-- Ordering (RULES §4.7): applies after create_meetings (20260719215139, FK to
-- public.meetings) and create_profiles (20260719215138, FK to public.profiles).
--
-- Design note — why its own table, not a `meetings.live_notes` column:
--   the notes conductor folds roughly every 25s, so a 60-minute call writes ~150
--   times. As a column that is ~150 whole-tuple rewrites (plus TOAST churn on a
--   jsonb payload) of `public.meetings` — the table `verifyMeetingOwnership` reads
--   at every session start and the RAG sweeper scans by `ended_at`/`indexed_at`. A
--   narrow dedicated table keeps that churn off the hot path entirely.
--
-- Design note — `user_id` is DENORMALIZED (also derivable via meeting_id ->
-- meetings), carried directly so the RLS predicate stays a flat
-- `user_id = auth.uid ()` with no join into meetings. Same rationale, and the same
-- application-side obligation to set it to the parent meeting's owner, as
-- public.transcripts.
--
-- Design note — `meeting_id` is the PRIMARY KEY rather than a surrogate `id`:
-- there is exactly ONE live-notes row per meeting. That is what lets the server
-- write with a single `insert ... on conflict (meeting_id) do update ... where
-- live_notes.rev < excluded.rev` — an atomic upsert with an optimistic-concurrency
-- guard, no surrounding transaction and no read-modify-write race.
--
-- Design note — SERVER-AUTHORED data. `authenticated` gets SELECT and nothing
-- else: no insert/update policy, no insert/update grant. Contrast public.meetings,
-- whose original blanket `grant update ... to authenticated` had to be walked back
-- in 20260725120000; live notes never open that hole in the first place.
--
-- `live_notes` joins the table list for the compliance purge (RULES §3) whenever
-- `scripts/purge/` is written — it does not exist yet (see live-notes.md §13 F3).
--
-- Reverse:
--   drop table if exists public.live_notes;   -- safe pre-launch; no dependents
-- (reversal belongs in a future contract-step migration, never by editing this file.)

create table public.live_notes (
  meeting_id uuid primary key references public.meetings (id),
  user_id uuid not null references public.profiles (id),
  -- The full v2 MeetingNotes object (packages/shared/src/notes.ts), `source:'live'`.
  notes jsonb not null,
  -- Monotonic per-meeting revision, bumped once per fold that changed state. The
  -- optimistic-concurrency guard on write and the client's out-of-order drop key —
  -- not a display field.
  rev integer not null default 0,
  updated_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); reads filter
  -- `deleted_at is null`.
  deleted_at timestamptz
);

-- Owner-scoped reads hit user_id (the RLS predicate). meeting_id needs no index —
-- it is the primary key.
create index live_notes_user_id_idx on public.live_notes (user_id);

-- RLS ships in the SAME migration as the table (RULES §4.9).
alter table public.live_notes enable row level security;

-- SELECT only, ownership-only, for `authenticated`; anon gets nothing. Flat
-- `user_id = auth.uid ()` (the reason user_id is denormalized above — no join).
--
-- There is deliberately NO insert, update, or delete policy: live notes are
-- written by the server (service_role) alone. A client that could forge them could
-- forge the call record the post-call pipeline reconciles against.
create policy live_notes_select_own
  on public.live_notes
  for select
  to authenticated
  using (user_id = auth.uid ());

-- Grants ship with the table (mirroring transcripts): new public tables are NOT
-- auto-exposed to the Data API roles under this stack's default (config.toml [api]).
-- authenticated gets SELECT and only SELECT — the policy above would be moot
-- without the grant, and the grant would be a hole without the policy.
-- service_role (bypasses RLS) gets the full set for the server store / purge job.
grant select on public.live_notes to authenticated;
grant select, insert, update, delete on public.live_notes to service_role;
