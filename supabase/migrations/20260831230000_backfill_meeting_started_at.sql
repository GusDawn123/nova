-- Desktop-created calls were born with started_at null (fixed at the source on
-- 2026-08-31), which history renders as UNDATED. created_at is the honest stand-in:
-- the desktop creates the row at the moment the session starts.
-- Reverse: none — restoring the nulls would only restore the lie.
update public.meetings
set started_at = created_at
where started_at is null
  and deleted_at is null;
