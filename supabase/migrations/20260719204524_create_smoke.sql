-- Migration: create the `_smoke` scaffold table.
--
-- Purpose: prove the server -> Postgres round trip end to end (Phase 0.5). The
-- table name is mandated by the LOOP_PLAYBOOK; the leading underscore requires
-- quoting the identifier.
--
-- Reverse: DROP TABLE IF EXISTS public."_smoke";  (safe — scaffold-only table,
-- no dependents; reversal belongs in a future contract-step migration if this is
-- ever retired, never by editing this applied file.)

create table public."_smoke" (
  id uuid primary key default gen_random_uuid(),
  note text not null,
  created_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); standard reads
  -- filter `deleted_at is null`.
  deleted_at timestamptz
);

-- RLS ships in the SAME migration as the table (RULES §4.9): no window where the
-- table exists unprotected. No policies are defined on purpose — with RLS enabled
-- and zero policies, the anon/authenticated roles are locked out entirely, while
-- the service_role (used by the server adapter) bypasses RLS. That is the correct
-- posture for a server-only scaffold table with no user-facing access.
alter table public."_smoke" enable row level security;

-- Grants ship with the table too. New public tables are NOT auto-exposed to the
-- Data API roles under the current default (see config.toml [api]), so the server
-- adapter's service_role would hit "permission denied" without this. Grant ONLY
-- service_role — anon/authenticated get nothing, reinforcing the RLS lockout above.
grant select, insert, update, delete on public."_smoke" to service_role;
