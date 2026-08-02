-- Migration: create `public.note_item_state` — per-item USER state over the notes a
-- meeting produced, starting with action-item completion (Phase 8.5,
-- docs/DESIGN/notes-ui.md §6.3).
--
-- Ordering (RULES §4.7): applies after create_meetings (20260719215139, FK to
-- public.meetings) and create_profiles (20260719215138, FK to public.profiles).
--
-- Design note — why a table and not a field inside `meetings.notes`:
--   the notes blob is SERVER-AUTHORED derived content. It is overwritten wholesale
--   by every regenerate, and `authenticated` has no write grant on it (20260725120000
--   walked that grant back). Completion is the opposite: it is authored by the user
--   and must survive a regenerate. Storing it in the blob would mean either handing
--   the client write access to the notes column — reopening the hole that migration
--   just closed — or losing the user's checkmarks on every regeneration.
--
-- Design note — `item_text` is stored ALONGSIDE `item_id`, and this is the crux.
--   Note ids (`a1`, `a2`, …) are POSITIONAL counters minted server-side, not durable
--   identities: `POST /meetings/:id/notes/regenerate` re-runs the whole pipeline, so
--   `a2` afterwards may be a different action item than `a2` before. Keying
--   completion on the id alone would silently slide a user's checkmark onto a task
--   they never finished — strictly worse than losing it.
--
--   So the read path honours a stored row only while its `item_text` still matches
--   the current item at that id, at the SAME jaccard threshold `reconcile-ids.ts`
--   already uses to decide "is this the same item?" across the live→final swap
--   (RECONCILE_THRESHOLD = 0.6). Rewording survives; replacement does not; the state
--   self-heals either way. Reusing that threshold rather than inventing a hash keeps
--   ONE definition of item identity in the codebase.
--
-- Design note — SERVER-AUTHORED WRITES. `authenticated` gets SELECT and nothing
--   else, matching public.live_notes. Unlike profiles.role/plan or meetings.
--   indexed_at there is no privilege-bearing column here, so a client write grant
--   would be defensible — but routing writes through PUT /meetings/:id/notes/items/
--   :itemId also lets the server reject an itemId that is not an action item in the
--   meeting's current notes, which keeps the table free of junk rows and keeps
--   `item_text` server-supplied (the client cannot desync the staleness guard by
--   sending text that never appeared in the notes).
--
-- `note_item_state` joins the table list for the compliance purge (RULES §3)
-- whenever `scripts/purge/` is written — it does not exist yet (live-notes.md §13 F3).
--
-- Reverse:
--   drop table if exists public.note_item_state;   -- safe pre-launch; no dependents
-- (reversal belongs in a future contract-step migration, never by editing this file.)

create table public.note_item_state (
  meeting_id uuid not null references public.meetings (id),
  -- Denormalized owner, carried so the RLS predicate stays a flat
  -- `user_id = auth.uid ()` with no join into meetings (the transcripts /
  -- live_notes precedent).
  user_id uuid not null references public.profiles (id),
  -- The server-minted note id (`a1`, `a2`, …). Scoped to the meeting, positional,
  -- and NOT stable across a regenerate — hence item_text below.
  item_id text not null,
  -- The item's text as it read when the user acted on it. The staleness guard:
  -- see the design note above.
  item_text text not null,
  -- When the user checked it. NULL means explicitly unchecked — the row is kept
  -- rather than deleted so an uncheck is a durable fact, not an absence that a
  -- stale cache could re-read as "never touched".
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft delete (RULES §3): "delete" = set deleted_at = now(); reads filter
  -- `deleted_at is null`.
  deleted_at timestamptz,
  -- One row per item per meeting — what lets the write be a single
  -- `insert ... on conflict (meeting_id, item_id) do update`, with no
  -- read-modify-write race.
  primary key (meeting_id, item_id)
);

-- Owner-scoped reads hit user_id (the RLS predicate). The (meeting_id, item_id)
-- prefix is served by the primary key, so meeting-scoped reads need no extra index.
create index note_item_state_user_id_idx on public.note_item_state (user_id);

-- RLS ships in the SAME migration as the table (RULES §4.9).
alter table public.note_item_state enable row level security;

-- SELECT only, ownership-only, for `authenticated`; anon gets nothing. Soft-deleted
-- rows are excluded AT THE POLICY, not just in application reads — the lesson from
-- 20260728120000, where live_notes' policy checked ownership alone and a stamped
-- deleted_at still served the row to the owner's JWT via the raw Data API.
create policy note_item_state_select_own
  on public.note_item_state
  for select
  to authenticated
  using (user_id = auth.uid () and deleted_at is null);

-- Grants ship with the table. authenticated gets SELECT and only SELECT: the
-- policy above would be moot without the grant, and the grant would be a hole
-- without the policy. Writes go through the server (service_role) so the item id
-- can be validated against the meeting's current notes.
grant select on public.note_item_state to authenticated;
grant select, insert, update, delete on public.note_item_state to service_role;
