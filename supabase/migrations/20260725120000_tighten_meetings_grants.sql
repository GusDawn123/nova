-- Migration: close the blanket `authenticated` write grant on `public.meetings`.
--
-- SECURITY FIX. This is the SAME hole `20260723100000` closed on `public.profiles`,
-- on the second table that shipped it. `create_meetings` (20260719215139) granted
-- table-wide INSERT + UPDATE to `authenticated`, and `meetings_update_own` scopes
-- rows but not COLUMNS — so a plain user JWT could write, straight through
-- PostgREST, every column the SERVER authors. On profiles that was a privilege
-- escalation; here it is worse, because two of those columns drive paid vendor work:
--
--   indexed_at   The RAG completion sweeper indexes meetings where `ended_at is not
--                null and indexed_at is null`. A client that NULLs it re-indexes the
--                same call on every sweep → unbounded Voyage embedding spend.
--   ended_at     What makes a meeting eligible for the notes sweep backstop. A client
--                that stamps it across N meetings enqueues N generate_notes jobs →
--                LLM spend, from one PostgREST write.
--   notes,       Server-authored output of the notes pipeline. A client could forge
--   notes_status,  "completed" notes it never paid for, or wedge the read model into
--   notes_generated_at,  a state the job lifecycle never produces.
--   follow_up
--   user_id      Re-parenting a row; RLS `with check` catches the cross-user case,
--                but the column has no business being client-writable at all.
--
-- Proven open before this migration and closed after it by
-- `apps/server/src/db/meetings-grants.integration.test.ts`, which drives real user
-- JWTs against PostgREST (42501 = insufficient_privilege).
--
-- Ordering (RULES §4.7): applies after create_meetings (the grant it revokes) and
-- after 20260722120000 (the notes columns it protects must exist).
--
-- Expand-only in the RULES §4.1 sense: no column is added, dropped, or retyped —
-- this removes only write paths that NO application code uses. The full set of
-- client writes in the tree today is `use-live-session.ts` inserting
-- `{ user_id, title }` and the RLS suite updating `title` / `deleted_at`; both are
-- re-granted below. service_role grants are untouched (it bypasses RLS and is how
-- the notes pipeline, sweeper, and reaper write).
--
-- Reverse:
--   revoke insert (user_id, title, started_at) on public.meetings from authenticated;
--   revoke update (title, deleted_at) on public.meetings from authenticated;
--   grant insert, update on public.meetings to authenticated;  -- NOT recommended: reopens the hole
-- (reversal belongs in a future migration, never by editing this file.)

revoke insert, update on public.meetings from authenticated;

-- The user-managed columns, and only these. Postgres column-scoped grants apply to
-- INSERT as well as UPDATE, so a smuggled `notes_status` on insert is refused too;
-- unnamed columns simply take their defaults (`id`, `created_at`, `notes_status`).
grant insert (user_id, title, started_at) on public.meetings to authenticated;

-- `title` is the user's own label; `deleted_at` is the soft-delete law (RULES §3 —
-- there is deliberately no DELETE grant, so this is the only way a user removes a
-- meeting). Everything else on this table is written by the server.
grant update (title, deleted_at) on public.meetings to authenticated;
