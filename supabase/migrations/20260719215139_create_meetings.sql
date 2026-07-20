-- Migration: create `public.meetings` — one row per copilot call/session owned by a
-- user.
--
-- Ordering (RULES §4.7): applies after create_profiles (FK to public.profiles).
--
-- Reverse:
--   drop table if exists public.meetings;   -- safe pre-launch; transcripts FK drops first
-- (reversal belongs in a future contract-step migration, never by editing this file.)

create table public.meetings (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.profiles (id),
  title text not null,
  started_at timestamptz,
  created_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); reads filter
  -- `deleted_at is null`.
  deleted_at timestamptz
);

-- Owner lookups (list-my-meetings) hit user_id on every query.
create index meetings_user_id_idx on public.meetings (user_id);

-- RLS ships in the SAME migration as the table (RULES §4.9).
alter table public.meetings enable row level security;

-- Ownership-only predicates for the `authenticated` role; anon gets nothing. The
-- predicate is a flat `user_id = auth.uid()` (no joins).
--
-- No DELETE policy on purpose: users soft-delete via UPDATE of deleted_at; hard
-- deletes are service-role-only (RULES §3 soft-delete law). Soft-delete visibility
-- (`deleted_at is null`) is a QUERY convention, not baked into these policies —
-- the predicates are ownership-only so the server can still read tombstones.
create policy meetings_select_own
  on public.meetings
  for select
  to authenticated
  using (user_id = auth.uid ());

create policy meetings_insert_own
  on public.meetings
  for insert
  to authenticated
  with check (user_id = auth.uid ());

create policy meetings_update_own
  on public.meetings
  for update
  to authenticated
  using (user_id = auth.uid ())
  with check (user_id = auth.uid ());

-- Grants ship with the table (mirroring _smoke): new public tables are NOT
-- auto-exposed to the Data API roles under this stack's default (config.toml [api]).
-- authenticated gets select/insert/update to exercise the policies (no delete —
-- soft-delete-only); service_role (bypasses RLS) gets the full set for the server
-- adapter and the purge job.
grant select, insert, update on public.meetings to authenticated;
grant select, insert, update, delete on public.meetings to service_role;
