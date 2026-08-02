# ADR-0009 — Live notes: a fold over the transcript, not a second pipeline

Status: accepted 2026-07-29. Context: Phase 5 produces notes AFTER a call ends, which
means the most useful minute of a sales call — the one where you are still on it — has
no structured summary at all. Phase 8 makes the notes exist DURING the call. The Phase 7
copilot already streams suggestions off the live transcript, so the transcript, the
metering seam and the plan gate were in place; what was missing was a durable, ordered,
cheap way to maintain a *document* rather than a stream of one-off answers.

## Decisions

1. **Live notes are a FOLD, not a re-run of the post-call pipeline.**
   Every tick sends the model the current notes plus the new transcript window and asks
   for OPS (add/revise/drop against item ids), which `applyFold` applies to state
   (`live-fold.ts`, split across `live-fold-ops.ts` / `live-fold-state.ts` for the
   ~400-line cap). Rejected alternative: re-running `modules/notes` classify →
   map-reduce → verify every N seconds. It costs a full pipeline per tick, and because
   each run is independent it rewrites its own prose — a tl;dr that churns every 25
   seconds reads as instability, not freshness.

2. **The fold prompt sees an id + text DIGEST, never the stored quotes.**
   `prompts/live-fold.ts` renders items as `id + text` only. The model therefore cannot
   return a quote at all, so it structurally cannot rewrite one — quote fidelity is a
   property of the interface rather than of a verification step we have to run and trust.
   `applyFold` additionally clamps ten ways and never throws: a malformed op degrades to
   "no change", because a live surface that blanks out is worse than one that lags.

3. **Storage is its own table (`public.live_notes`, migration `20260726120000`), not a
   column on `meetings`.**
   Keyed by `meeting_id`, with a DENORMALIZED `user_id` so the RLS policy needs no join.
   `authenticated` gets SELECT only — no write grant — and the SELECT policy filters
   `deleted_at` AT THE POLICY (migration `20260728120000` carries that lesson: an
   application-level filter is not a policy). Rejected alternative: writing into
   `meetings.notes`, which would put the live fold and the post-call pipeline in write
   contention over one jsonb document, and would need a client write grant on the row
   that also carries `indexed_at` / `ended_at`.

4. **Ordering is a monotonic `rev`, not a timestamp.**
   The store does a `rev`-guarded atomic upsert; the wire event announces the rev; the
   client rule is "drop any update whose `rev` <= the last seen". A reconnect that
   re-delivers a stale payload therefore cannot walk a user's notes backwards. `rev 0`
   is a valid first update, so the client guard keys off `rev === null`, not falsiness.
   Timestamps were rejected: two writers and one clock is a race, and the ordering
   question is "which is newer", which a counter answers exactly.

5. **`notes.update` is additive; the protocol version stays `v: 1`.**
   Nothing about the existing wire contract changes, so a client that ignores the event
   behaves exactly as before. Bumping the protocol for a purely additive event would
   force every consumer through a migration for no behavioural reason.

6. **Notes v2 splits CONTENT from IDENTITY, with a v1 ∪ v2 read boundary.**
   `identifyNotes` mints ids; `storedNotesSchema` parses either version and
   `upcastNotesV1` lifts v1 rows on read. Ids are what make ops addressable (decision 1)
   and what item-completion keys against later. The post-call LLM contract did NOT
   change — no prompt moved, so the Phase 5 accuracy gates still apply unchanged.

7. **Item identity is jaccard ≥ 0.6 over normalized word sets — ONE implementation.**
   `reconcile-ids.ts` answers "is this the same item?" for the live → final swap, and is
   EXPORTED for reuse rather than duplicated. Two slightly different definitions of item
   identity in one codebase is exactly how a user's checkmark ends up on a task they
   never finished.

8. **The conductor is a second transcript consumer, not a branch inside the first.**
   `session.ts` fans out to `LiveTranscriptConsumer[]` — copilot #1, notes #2 — with
   per-consumer disposal, and a throw in one consumer can neither starve the next nor
   escape into the relay. The notes conductor hydrates-and-emits at start, then ticks on
   a debounce with a single in-flight latch, a per-session fold budget, a quota stop, and
   dispose-without-write.

9. **The plan gate resolves LAZILY on the first tick, then latches — and fails CLOSED.**
   `canUseLiveNotes(plan)` is never called on the session-start path: session start is
   the latency-critical moment and live notes are not needed for tens of seconds. With no
   `usage_events` ledger reachable, the answer is NO (fail closed) — an unmetered path to
   a paid vendor is the one thing RULES forbids outright.

## Consequences

- Cost is a near-linear function of the fold interval, currently the 25s guess
  (~$0.10–0.15 per hour-long call). It is now measurable against a real call, and it is
  the one knob to turn if live notes are too expensive at scale. **Open:** whether
  `canUseLiveNotes` stays `plan === "pro"` or earns its own tier (§12.2) is Gustavo's
  call — one line in `modules/metering/config.ts`.
- A live surface can now disagree with the final notes for the length of one fold. That
  is accepted: prose reads as provisional. It is also why the meetings list takes the
  tl;dr fallback (notes → live_notes → null) but NOT `conversation_type` or
  `action_item_count` — a chip that flips from "interview" to "sales", or a count ticking
  2 → 4 → 3, presents a moving value as a settled one.
- `modules/live` now reaches the notes domain through exactly one interface
  (`live-fold-runner.ts`: prompt → ladder → reducer), so the two modules stay separable.
