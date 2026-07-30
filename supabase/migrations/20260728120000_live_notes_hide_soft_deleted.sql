-- Exclude soft-deleted rows from the live_notes read policy.
--
-- `20260726120000_create_live_notes.sql` shipped the table with a `deleted_at`
-- column whose own comment states "reads filter `deleted_at is null`" — but the
-- SELECT policy only ever checked ownership:
--
--   using (user_id = auth.uid ())
--
-- So stamping `deleted_at` removed the row from every application read while
-- PostgREST kept serving it to the owner's JWT. RULES §3 makes soft delete THE
-- delete, and a policy is the only layer a raw Data API call cannot route around
-- — application-side filtering is not equivalent, because the Data API is exposed
-- directly to the client.
--
-- Scope: owner-reads-own only. This was never cross-tenant — `user_id = auth.uid()`
-- held throughout, so no user could ever see another's rows, deleted or not.
--
-- The create migration is already applied and is therefore never edited (RULES §4);
-- this replaces the policy in place. Drop-then-create rather than ALTER POLICY so
-- the statement is idempotent against a database where the original never landed.

drop policy if exists live_notes_select_own on public.live_notes;

create policy live_notes_select_own
  on public.live_notes
  for select
  to authenticated
  using (user_id = auth.uid () and deleted_at is null);

comment on policy live_notes_select_own on public.live_notes is
  'Owner-only reads, soft-deleted rows excluded (RULES §3). Server-authored table: no insert/update/delete policy by design.';
