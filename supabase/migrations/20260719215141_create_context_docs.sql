-- Migration: create `public.context_docs` — user-supplied context documents that
-- ground the copilot's RAG memory (embedding columns arrive in a later phase — none
-- are added here; expand-only, no speculative columns).
--
-- Ordering (RULES §4.7): applies after create_profiles (FK to public.profiles).
--
-- Reverse:
--   drop table if exists public.context_docs;   -- safe pre-launch; no dependents
-- (reversal belongs in a future contract-step migration, never by editing this file.)

create table public.context_docs (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.profiles (id),
  title text not null,
  content text not null,
  created_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); reads filter
  -- `deleted_at is null`.
  deleted_at timestamptz
);

-- Owner lookups (list-my-docs) hit user_id on every query.
create index context_docs_user_id_idx on public.context_docs (user_id);

-- RLS ships in the SAME migration as the table (RULES §4.9).
alter table public.context_docs enable row level security;

-- Ownership-only predicates for the `authenticated` role; anon gets nothing. Flat
-- `user_id = auth.uid()` (no joins).
--
-- No DELETE policy on purpose: users soft-delete via UPDATE of deleted_at; hard
-- deletes are service-role-only (RULES §3 soft-delete law).
create policy context_docs_select_own
  on public.context_docs
  for select
  to authenticated
  using (user_id = auth.uid ());

create policy context_docs_insert_own
  on public.context_docs
  for insert
  to authenticated
  with check (user_id = auth.uid ());

create policy context_docs_update_own
  on public.context_docs
  for update
  to authenticated
  using (user_id = auth.uid ())
  with check (user_id = auth.uid ());

-- Grants ship with the table (mirroring _smoke): new public tables are NOT
-- auto-exposed to the Data API roles under this stack's default (config.toml [api]).
-- authenticated gets select/insert/update (no delete — soft-delete-only);
-- service_role (bypasses RLS) gets the full set for the server adapter / purge job.
grant select, insert, update on public.context_docs to authenticated;
grant select, insert, update, delete on public.context_docs to service_role;
