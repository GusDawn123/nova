-- Migration: create `public.deletion_requests` — the account-deletion purge queue.
--
-- Ordering (RULES §4.7): applies after create_profiles (FK to public.profiles).
-- Its timestamp sorts after the whole Phase 1 auth-domain set for that reason.
--
-- Lifecycle: a row is enqueued when a user requests account deletion (server-side,
-- service_role only — the App Store deletion mandate). `processed_at` is NULL while
-- the request is pending; the purge worker stamps it when the hard-delete finishes.
-- This is a LIFECYCLE column, NOT a soft-delete tombstone: a purge-queue row is
-- operational state, not user data, so there is deliberately no `deleted_at` here —
-- the worker removes the row itself when it is done.
--
-- PURGE-WORKER CONTRACT (later phase — scripts/purge/): to erase a user the worker
-- MUST hard-delete children BEFORE the auth.users row, in FK-dependency order:
--   transcripts -> meetings -> context_docs -> deletion_requests, THEN auth.users.
-- Rationale: `public.profiles` cascades from `auth.users` (ON DELETE CASCADE), but
-- the child tables (meetings/transcripts/context_docs) and this queue reference
-- `public.profiles(id)` with NO ACTION (the FK default). Deleting the auth.users row
-- would therefore fail on those child FKs unless the children are purged first.
--
-- Reverse:
--   drop table if exists public.deletion_requests;   -- safe pre-launch; no dependents
-- (reversal belongs in a future contract-step migration, never by editing this file.)

create table public.deletion_requests (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.profiles (id),
  requested_at timestamptz not null default now(),
  -- Lifecycle column (NOT soft-delete): NULL = pending purge; set by the worker
  -- when the hard-delete for this user completes.
  processed_at timestamptz
);

-- The server's idempotency check ("does an unprocessed request already exist for
-- this user?") and the worker's pending-queue scan both filter on user_id.
create index deletion_requests_user_id_idx on public.deletion_requests (user_id);

-- RLS ships in the SAME migration as the table (RULES §4.9): no window where the
-- table exists unprotected.
alter table public.deletion_requests enable row level security;

-- No policies on purpose — same posture as `_smoke`: with RLS enabled and zero
-- policies, the anon/authenticated roles are locked out entirely, while service_role
-- (used by the server adapter and the purge worker) bypasses RLS. Enqueue and purge
-- are strictly server-side; users never read or write this table directly.
--
-- Grants ship with the table (mirroring _smoke): new public tables are NOT
-- auto-exposed to the Data API roles under this stack's default (config.toml [api]).
-- Grant ONLY service_role — anon/authenticated get nothing, reinforcing the lockout.
grant select, insert, update, delete on public.deletion_requests to service_role;
