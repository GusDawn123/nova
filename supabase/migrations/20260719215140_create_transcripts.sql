-- Migration: create `public.transcripts` — stored transcript text for a meeting.
--
-- Ordering (RULES §4.7): applies after create_meetings (FK to public.meetings) and
-- create_profiles (FK to public.profiles).
--
-- Design note: `user_id` is DENORMALIZED (also derivable via meeting_id -> meetings).
-- It is carried directly so the RLS predicate stays a flat `user_id = auth.uid()`
-- with no join into meetings — cheaper and simpler than a join-based policy. The
-- application is responsible for setting it to the parent meeting's owner on insert.
--
-- Reverse:
--   drop table if exists public.transcripts;   -- safe pre-launch; no dependents
-- (reversal belongs in a future contract-step migration, never by editing this file.)

create table public.transcripts (
  id uuid primary key default gen_random_uuid (),
  meeting_id uuid not null references public.meetings (id),
  user_id uuid not null references public.profiles (id),
  content text not null,
  created_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); reads filter
  -- `deleted_at is null`.
  deleted_at timestamptz
);

-- Fetch-transcripts-for-a-meeting hits meeting_id; owner-scoped reads hit user_id.
create index transcripts_meeting_id_idx on public.transcripts (meeting_id);
create index transcripts_user_id_idx on public.transcripts (user_id);

-- RLS ships in the SAME migration as the table (RULES §4.9).
alter table public.transcripts enable row level security;

-- Ownership-only predicates for the `authenticated` role; anon gets nothing. Flat
-- `user_id = auth.uid()` (the reason user_id is denormalized above — no join).
--
-- No DELETE policy on purpose: users soft-delete via UPDATE of deleted_at; hard
-- deletes are service-role-only (RULES §3 soft-delete law).
create policy transcripts_select_own
  on public.transcripts
  for select
  to authenticated
  using (user_id = auth.uid ());

create policy transcripts_insert_own
  on public.transcripts
  for insert
  to authenticated
  with check (user_id = auth.uid ());

create policy transcripts_update_own
  on public.transcripts
  for update
  to authenticated
  using (user_id = auth.uid ())
  with check (user_id = auth.uid ());

-- Grants ship with the table (mirroring _smoke): new public tables are NOT
-- auto-exposed to the Data API roles under this stack's default (config.toml [api]).
-- authenticated gets select/insert/update (no delete — soft-delete-only);
-- service_role (bypasses RLS) gets the full set for the server adapter / purge job.
grant select, insert, update on public.transcripts to authenticated;
grant select, insert, update, delete on public.transcripts to service_role;
