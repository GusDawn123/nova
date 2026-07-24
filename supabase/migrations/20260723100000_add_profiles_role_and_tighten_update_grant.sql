-- Migration: expand `public.profiles` with the `role` column
-- (developer | admin | customer) AND close a live privilege hole in the
-- `authenticated` UPDATE grant. Roles design: docs/DECISIONS/adr-0008-roles.md
-- (column-over-JWT-claim; assignment is a service-role write via
-- scripts/set_user_role.ts).
--
-- SECURITY FIX (shipped in the SAME migration as the column it protects):
-- create_profiles (20260719215138) granted table-wide UPDATE on profiles to
-- `authenticated`. RLS policies check the ROW (id = auth.uid()), not the
-- COLUMNS, so any signed-in user could run `update profiles set plan='pro'` on
-- their own row — a free→pro self-upgrade — and could have self-assigned
-- role='admin' the moment this column existed. The fix revokes the blanket
-- grant and re-grants UPDATE column-scoped to exactly the user-managed columns:
-- display_name (profile editing) and deleted_at (the soft-delete law, RULES §3).
-- plan stays writable only by service_role (the RevenueCat webhook seam) and
-- role only by service_role (the assignment script / future admin surface).
--
-- Ordering (RULES §4.7): applies after create_usage_events_and_plan
-- (20260722130000) — the `plan` column this revoke protects must exist.
-- Expand-only (RULES §4.1): the column is defaulted so old code is unaffected;
-- the grant tightening removes only write paths no application code ever used
-- (server writes go through service_role; the mobile app has no profile editor
-- yet).
--
-- Assignment one-liner (operational; prefer scripts/set_user_role.ts):
--   update public.profiles set role = 'developer' where id = '<user uuid>';
--
-- Reverse:
--   alter table public.profiles drop constraint if exists profiles_role_check;
--   alter table public.profiles drop column if exists role;
--   revoke update (display_name, deleted_at) on public.profiles from authenticated;
--   grant update on public.profiles to authenticated;  -- NOT recommended: reopens the hole
-- (reversal belongs in a future contract-step migration, never by editing this file.)

-- ---------------------------------------------------------------------------------
-- The role column. Closed set via CHECK — the DB is the source of truth the zod
-- enums mirror (packages/shared roleSchema, db/roles.ts row parse).
-- ---------------------------------------------------------------------------------
alter table public.profiles
  add column role text not null default 'customer'
    constraint profiles_role_check check (role in ('developer', 'admin', 'customer'));

-- ---------------------------------------------------------------------------------
-- The grant tightening (the security fix). Postgres column-scoped grants: after
-- this, `update profiles set plan/role/... = ...` as `authenticated` is
-- "permission denied for table profiles" even on the user's own row, while
-- display_name edits and the soft-delete tombstone keep working through the
-- existing profiles_update_own RLS policy. service_role grants are untouched
-- (it bypasses RLS and keeps full UPDATE for the webhook/assignment/purge paths).
-- ---------------------------------------------------------------------------------
revoke update on public.profiles from authenticated;

grant update (display_name, deleted_at) on public.profiles to authenticated;
