-- Migration: create `public.profiles` — the per-user application profile, keyed 1:1
-- to `auth.users`.
--
-- Ordering (RULES §4.7): this migration MUST apply before meetings/transcripts/
-- context_docs — those tables FK to `public.profiles(id)`. Its timestamp is the
-- earliest of the Phase 1 auth-domain set for that reason.
--
-- Reverse:
--   drop trigger if exists on_auth_user_created on auth.users;
--   drop function if exists public.handle_new_user();
--   drop table if exists public.profiles;   -- safe pre-launch; downstream FKs drop first
-- (reversal belongs in a future contract-step migration, never by editing this file.)

create table public.profiles (
  -- 1:1 with auth.users; deleting the auth user cascades the profile away.
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); reads filter
  -- `deleted_at is null`.
  deleted_at timestamptz
);

-- RLS ships in the SAME migration as the table (RULES §4.9): no window where the
-- table exists unprotected.
alter table public.profiles enable row level security;

-- Policies are for the `authenticated` role only. anon gets nothing.
--
-- No INSERT policy on purpose: profile rows are created by the security-definer
-- trigger below (the standard Supabase pattern), never by the client — so clients
-- must not be able to forge one.
-- No DELETE policy on purpose: users soft-delete via UPDATE of deleted_at; hard
-- deletes are service-role-only (RULES §3 soft-delete law).
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid ());

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid ())
  with check (id = auth.uid ());

-- Auto-provision a profile row whenever a new auth.users row is created. SECURITY
-- DEFINER so it runs as the table owner (bypassing RLS / the missing INSERT policy);
-- search_path is pinned to empty per Supabase security guidance so the function
-- cannot be hijacked by a mutable search_path (all objects are schema-qualified).
create function public.handle_new_user ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id)
  values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user ();

-- Grants ship with the table (RULES §4.9 posture, mirroring the _smoke migration):
-- new public tables are NOT auto-exposed to the Data API roles under this stack's
-- default (see config.toml [api]), so the server's service_role would hit
-- "permission denied" without this. authenticated needs select/update to exercise
-- the policies above; insert/delete are intentionally withheld from it (trigger-only
-- insert, soft-delete-only). service_role (bypasses RLS) gets the full set for the
-- server adapter and the purge job.
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;
