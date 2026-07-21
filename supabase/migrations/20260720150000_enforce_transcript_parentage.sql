-- Migration: enforce transcript PARENTAGE in the write policies (security /
-- data-integrity fix, carried HARD BLOCKER from Phase 1 review).
--
-- Ordering (RULES §4.7): applies after create_transcripts (20260719215140) — it
-- drops-and-recreates that table's insert/update policies.
--
-- The hole (proven live in Phase 1 review): the transcripts insert/update policies
-- checked only `user_id = auth.uid()`, NOT that the referenced `meeting_id` belongs
-- to the writer and is still live. So User B could insert a transcript they own
-- against User A's meeting (user_id = self satisfies the flat check), corrupting
-- parentage AND wedging A's account purge — the foreign child blocks A's `meetings`
-- delete (FK 23503). This tightens both write policies to require the parent meeting
-- to EXIST, be owned by `auth.uid()`, and not be soft-deleted.
--
-- `user_id = auth.uid()` is KEPT alongside the EXISTS clause: the denormalized
-- `user_id` column is still the transcript's own owner and must equal the writer
-- (it is what the flat SELECT policy and the owner index rely on). The EXISTS clause
-- is the added parentage guard.
--
-- Note on soft-delete-in-with-check (UPDATE): requiring `m.deleted_at is null` on the
-- UPDATE with-check means an authenticated user cannot mutate a transcript whose
-- parent meeting is already a tombstone. That is intended — once a meeting is
-- soft-deleted its transcripts are hidden at the app layer, and hard purge of dead
-- children is service_role's job (bypasses RLS). Live-meeting edits and the
-- transcript's own soft-delete (parent still live) are unaffected.
--
-- Policies are NOT data (RULES §4.2/§4.6): drop-and-recreate of a policy is a safe,
-- non-destructive change — no table/column/row is dropped. This is an expand-style
-- tightening; there is no backfill (no rows exist pre-launch; transcripts are not yet
-- writable in-product).
--
-- Reverse:
--   drop policy if exists transcripts_insert_own on public.transcripts;
--   drop policy if exists transcripts_update_own on public.transcripts;
--   create policy transcripts_insert_own on public.transcripts
--     for insert to authenticated with check (user_id = auth.uid ());
--   create policy transcripts_update_own on public.transcripts
--     for update to authenticated
--     using (user_id = auth.uid ()) with check (user_id = auth.uid ());
-- (reversal belongs in a future migration, never by editing this file.)

-- INSERT: own the transcript row AND own the live parent meeting.
drop policy transcripts_insert_own on public.transcripts;

create policy transcripts_insert_own
  on public.transcripts
  for insert
  to authenticated
  with check (
    user_id = auth.uid ()
    and exists (
      select 1
      from public.meetings m
      where m.id = meeting_id
        and m.user_id = (select auth.uid ())
        and m.deleted_at is null
    )
  );

-- UPDATE: same parentage guard on the resulting row (with check) so a transcript can
-- never be re-parented onto another user's — or a dead — meeting. `using` stays a
-- flat ownership check (which rows the writer may target).
drop policy transcripts_update_own on public.transcripts;

create policy transcripts_update_own
  on public.transcripts
  for update
  to authenticated
  using (user_id = auth.uid ())
  with check (
    user_id = auth.uid ()
    and exists (
      select 1
      from public.meetings m
      where m.id = meeting_id
        and m.user_id = (select auth.uid ())
        and m.deleted_at is null
    )
  );
