# Live Notes — the running-notes fold (Phase 8, backend)

> **STATUS: DRAFT / implementation plan.** Not yet built. Ratified decisions are marked
> as such; open questions for Gustavo are at the bottom. The ADR (`adr-0009-live-notes`)
> and the ARCHITECTURE/CLAUDE updates get written *during* implementation, per RULES §
> living docs — this file is the design source they will cite.
>
> Revised 2026-07-25 after a code-grounded review of the first draft. §0 records what
> changed and why; the rest is the plan as it should be built.

---

## BUILD STATUS (updated 2026-07-26) — read this first

Branch: **`dev-claude-live-notes`**, stacked on `dev-claude-live-copilot` (Phase 7 is
not in `development` yet, so this branch sits on top of it rather than off
`development` — its PR will show only its own diff once Phase 7 merges).

**Done and committed** (`npm run check` green throughout — 738 passed / 0 failed with
the local stack up):

| commit | what |
|---|---|
| `b109d51` | **Slice 1 — notes v2.** Content/identified schema split, `identifyNotes`, `upcastNotesV1`, `storedNotesSchema` (the v1 read boundary), consumers updated in `pipeline.ts` + `map-reduce.ts` + the follow-up prompt renderer. Post-call LLM contract UNCHANGED — no prompt moved, accuracy gates untouched. |
| `47941f4` | `npm run typecheck` never typechecked a single test file (root tsconfig referenced only `*.build.json`, which exclude `**/*.test.ts`). Wired in + fixed the 15 latent errors it exposed. |
| `60c2977` | **Security:** `public.meetings` carried a blanket `authenticated` write grant — same hole class as the profiles fix, plus a vendor-spend vector via `indexed_at`/`ended_at`. Proven open with a real JWT, then closed. |
| `ad9d19d` | The metering audit only scanned 3 hardcoded files, not the tree — a new unmetered `createLlmRouter(` anywhere else passed clean. Added a tree-wide backstop. |
| `557dcd2` | **F2 fixed:** `transcript.input` gains `origin`; `copilot_question` is answered but never persisted (was contaminating post-call notes AND RAG memory). New `LiveConductor.onDirectQuestion` bypasses the trigger gate. |
| `74aef72` | `supabase/seed.sql` (dev account survives a reset), `npm run db:migrate` (forward-apply, the production model), Test Live input restored to `origin: "utterance"`. |
| `8546466` | **pg Pool had no `error` handler** at any of 3 sites — one dropped idle connection killed the whole process (observed live). New `db/pg-pool.ts` factory + a static audit + a real-Postgres termination test. |
| `c5e98de` | **Slice 2 — wire event + persistence.** §6 `notes.update` (additive, protocol stays `v: 1`); §7 `public.live_notes` (migration `20260726120000`, denormalized `user_id`, select-own RLS, NO `authenticated` write grant) + `db/live-notes.ts` (`LiveNotesStore`: user-scoped read, `rev`-guarded atomic upsert, parsed BOTH directions) riding the memoised jobs pool; §7 read model (`notesReadResponseSchema` gains `live_notes`/`live_notes_rev`, composed at the notes route behind the existing 404 gate). **Plus the slice-1 leftover:** `storedNotesSchema` was built but never wired — `db/notes.ts` and `db/schema.ts` still parsed `meetings.notes` with `meetingNotesSchema` (`z.literal(2)`), so a stored v1 row 500'd the read model. Both boundaries swapped, with a route-level regression test. No behavior change: nothing writes `live_notes` and nothing emits `notes.update` until slice 3. |
| `859f6e6` | **Slice 3 — the fold, the loop, the gate.** §3 `live-fold.ts` (`applyFold`, all ten clamps, never throws; split across `live-fold-ops.ts` / `live-fold-state.ts` for the ~400-line cap) + `live-fold-runner.ts` (prompt → ladder → reducer, so `modules/live` reaches the notes domain through ONE interface) + `prompts/live-fold.ts` (ops against an id+text digest — no quotes back, so the model structurally cannot rewrite one) + `reconcile-ids.ts`. §4 `notes-conductor.ts` + `notes-conductor-config.ts`: hydrate-and-emit at start, debounced tick, single in-flight latch, per-session fold budget + quota stop, narrative window, dispose-without-write. §5 `notes-trigger.ts` over a shared `small-talk.ts` extracted verbatim from `trigger.ts`. **Still inert** — nothing constructs the conductor until §8. New: 76 tests, incl. the adversarial non-teleport suite and the fake-timer delta-lifecycle suite. |
| `a933876` | **Slice 4 — the wiring; the feature is ON.** §8: `LiveTranscriptConsumer[]` fan-out in `session.ts` (copilot #1, notes #2, per-consumer disposal, and a throw in one no longer starves the next or escapes into the relay); `maybeCreateLiveNotesConductorFactory` as its OWN top-level function in `metering-wiring.ts`, consumed by `modules/live/routes.ts`; `canUseLiveNotes(plan)` resolved LAZILY on the first tick (never on the session-start path) then latched, fail-CLOSED; `reconcileIds` in the post-call handler, best-effort so a live-notes outage can never fail a generation. **Audit fix:** `functionBlocks` never matched `export function`, so `metering-wiring.ts` collapsed into ONE block and every per-function metering assertion was vacuous — exactly the hole §8 warned about. **Prompt fix caught by the e2e:** the narrative was offered on the first fold, so the model declined and the placeholder tldr survived; it is now REQUIRED until one lands. |

**THE BACKEND FEATURE IS LIVE** as of slice 4 — proven end to end over a real socket
against a real model (`live.notes.e2e.test.ts`): a `pro` call streams `notes.update`,
persists its `live_notes` row at the announced rev, and a `free` call on the identical
path gets zero events and zero rows.

**Next up: what is left.**
1. **§12.2 needs Gustavo:** `canUseLiveNotes` currently reads `plan === "pro"`. Pro-only,
   or its own tier? It is one line in `modules/metering/config.ts`.
2. **§12.3/§12.4 cost:** the fold interval is still the 25s guess. It is a near-linear
   cost lever (~$0.10–0.15/hour-call at 25s) and now measurable against a real call.
3. **Mobile (Gustavo):** render `notes.update` — the client rule is drop any update whose
   `rev` <= the last seen. All animation is his.
4. **Docs before the PR:** `adr-0009-live-notes`, ARCHITECTURE, CLAUDE (RULES §8).
5. Real mic capture (Phase 9) is what makes this reachable outside the Test Live tab.

**Local dev:** `npm run db:migrate` to pick up migrations (NOT `db:reset` — that drops
everything; it exists to prove replay-from-zero). Seeded dev account:
`dev@nova.test` / `nova-dev-1234`, role `developer` (a `customer` cannot see the Test
Live tab). After any `db:reset` the Kong gateway needs
`docker restart supabase_kong_nova supabase_rest_nova` before auth works again.

**PRE-LAUNCH BLOCKER, unrelated to live notes but must not be lost:** `DELETE /account`
returns 202 and deletes nothing — `deletion_requests` has no consumer and
`scripts/purge/` does not exist (RULES §3 points at it). That is a legal obligation
under GDPR/CCPA and an **App Store gate** (Guideline 5.1.1(v) requires in-app account
deletion), so it blocks TestFlight → App Store. See §13 F3.

---

## 0. What changed from the first draft, and why

| # | First draft | Revised | Why |
|---|---|---|---|
| 1 | Model returns the **whole updated notes object** each tick | Model returns **ops** (`add`/`update`/`retract` + optional narrative); the **server** folds them into state and emits the whole object on the wire | Whole-object rewrite is the root cause of four separate problems: output cost ~O(all notes × ticks), 10–25s per-tick latency, overlapping ticks, and teleport-by-model. Ops fix all four. The **client contract is unchanged** — `notes.update` still carries the full object. |
| 2 | `version: z.literal(1)` → `z.literal(2)`, "update every reader/writer" | v2 is canonical; **read boundaries accept `v1 ∪ v2` and upcast in code**. No backfill migration. | `db/notes.ts:64` *and* `db/schema.ts:61` both parse `meetings.notes` with `meetingNotesSchema`. A bare literal bump makes every pre-existing row throw on read → `GET /meetings/:id/notes` returns **500**, not 404, forever. |
| 3 | Ids added to `meetingNotesSchema`, post-call pipeline must emit them | **Content schemas (id-less) vs identified schemas.** The LLM contract on the post-call path is **byte-for-byte unchanged**; ids are minted in code at assembly. | `pipeline.ts:203 requestSchemaFor()` derives the model's request schema from `meetingNotesSchema`. Adding `id` there would demand ids from the model → prompt churn + accuracy-gate risk on a pipeline that is currently 5/5 green. Minting in code costs nothing and risks nothing. |
| 4 | `meetings.live_notes jsonb` + `live_notes_rev` | Dedicated **`public.live_notes`** table, service-role writes only | ~150 UPDATEs/call on `meetings` rewrites the whole tuple + TOAST churn each time, on the table `verifyMeetingOwnership` hits at every session start and the RAG sweeper scans by `ended_at`/`indexed_at`. Also: `meetings` still carries a **table-wide `grant update ... to authenticated`** (see §9 finding F1) — a new column there would be client-writable. |
| 5 | Non-teleport asserted by a unit test on `applyFold` | Non-teleport is a **server-enforced churn ceiling**, tested with adversarial fixtures | A pure reducer over fixture model output tests your fixtures, not the model. A ceiling ("one fold may touch at most K existing items") is a real invariant, and "model returns a wholly rewritten object → reducer clamps it" is a real test. |
| 6 | "The tab swaps preview → final" at call end | Pure **`reconcileIds(live, final)`** so retained items keep their live ids | The swap *is* the forbidden teleport, deferred to the moment the user is most likely watching. Reconcile is pure, touches no LLM path, and gives the client a diff to animate. |
| 7 | Socket replay on reconnect | Conductor **hydrates from the DB at start** and emits one `notes.update` immediately; REST read model carries cold state | There is no session resume — `session.start` mints a fresh `sessionId` + a fresh `LiveSession`, and the one-per-user registry *refuses* the new socket with `concurrent_session` until the old disposer runs. A conductor built on reconnect would otherwise start with an empty prior and wipe an hour of notes. |
| 8 | `format.ts`, `ladder.ts` listed as id touch points | Neither is touched | `format.ts` is transcript rendering (`[mm:ss] Speaker: text`). `ladder.ts` is generic `runLadder<T>`. The real assembly sites are `pipeline.ts:140` and `map-reduce.ts:387`. |
| 9 | Metering threaded (`meterFor`) | Metering **plus a per-session fold budget** and a quota stop | Recording spend is not limiting spend. The only per-user live ceiling today is `stt_seconds`; the $50/day kill-switch only refuses *new* sessions. |
| 10 | (absent) | Live-path items run through **`verifyNotes`** (the existing pure substring check) | Otherwise the live preview shows quotes the final notes will flag `unverified` — a visible inconsistency, for free. |
| 11 | (absent) | Conversation type is **latched**; `casual → typed` once, never typed → different typed | `typeInsights` is a discriminated union: a mid-call `sales → interview` flip replaces the whole arm and drops every accrued objection. Mass teleport. |
| 12 | Second conductor field on `LiveSession` | `LiveTranscriptConsumer[]` fan-out | `session.ts` is 554 lines against a 400 soft cap and `onServerEvent` hardcodes `this.conductor?.on*`. A second hardcoded consumer is the third copy of that shape. |

Carried forward unchanged from the first draft (all ratified with Gustavo): separate loop
from the what-to-say conductor · semantic/debounced cadence with a cheap code gate ·
stable ids so the client diffs · live is a **preview**, post-call stays authoritative ·
ONE canonical schema shared by preview and final · abstract `canUseLiveNotes(plan)` seam ·
gemini is fine · Gustavo owns all animation.

---

## 1. Shape

Two loops watch the same transcript stream and share nothing:

```
                    ┌─────────────────────────────────────────┐
  STT / typed  ───▶ │ LiveSession.onServerEvent               │
                    │   fan-out → LiveTranscriptConsumer[]    │
                    └───────┬─────────────────────┬───────────┘
                            │                     │
              ┌─────────────▼──────┐   ┌──────────▼─────────────────┐
              │ conductor.ts       │   │ notes-conductor.ts         │
              │ "what to say"      │   │ "what was said"            │
              │ trigger.ts (pure)  │   │ notes-trigger.ts (pure)    │
              │ → suggestion.*     │   │ → live-fold.ts (pure)      │
              └────────────────────┘   │ → notes.update + live_notes│
                                       └────────────────────────────┘
```

The notes conductor holds the **authoritative state**; the model only proposes deltas.

---

## 2. Schema — `packages/shared/src/notes.ts`

Split every item schema into a **content** form (what the LLM produces — unchanged from
today) and an **identified** form (what is stored and sent on the wire).

```ts
/** Server-minted, stable for the life of an item. `<listPrefix><n>`: "d1", "a7", "q2". */
export const noteIdSchema = z.string().regex(/^[a-z]{1,2}\d+$/);

export const noteDecisionContentSchema = z.object({ text, quote, unverified });   // as today
export const noteDecisionSchema = noteDecisionContentSchema.extend({ id: noteIdSchema });
// …same split for noteActionItem*, and a new:
export const noteStringItemSchema = z.object({ id: noteIdSchema, text: z.string().min(1) });

/** What the post-call LLM is asked for — IDENTICAL to today's meetingNotesSchema body. */
export const notesContentSchema = z.object({ …, openQuestions: z.array(z.string()), … });

/** v2 canonical: what is stored, read, and sent on the wire. */
export const meetingNotesSchema = z.object({
  version: z.literal(2),
  …,
  openQuestions: z.array(noteStringItemSchema),
  risks: z.array(noteStringItemSchema),
  typeInsights: typeInsightsSchema,   // arms carry noteStringItemSchema[] too
  source: z.enum(["generated", "fallback", "live"]),
}).strict();
```

**`source: "live"`** marks a preview. Final stays `generated`/`fallback` — the UI keys its
"still forming" affordance off `source === "live"`, and its retry affordance off
`"fallback"` exactly as today.

Two pure helpers:

- **`identifyNotes(content, mint): MeetingNotes`** — wraps content items into identified
  items, minting ids by list-scoped counter. Called at `pipeline.ts:140` and
  `map-reduce.ts:387`. This is the *entire* post-call migration.
- **`upcastNotesV1(v1): MeetingNotes`** — same thing, over a stored v1 object, ids minted
  by array index. Deterministic: a stored v1 row is immutable, so repeated reads give
  identical ids.

`buildFallbackNotes` emits v2 with empty arrays.

### The v1 read boundary (the part the first draft would have broken)

```ts
export const storedNotesSchema = z.union([meetingNotesV1Schema, meetingNotesSchema])
  .transform((n) => (n.version === 1 ? upcastNotesV1(n) : n));   // → always v2
```

Swap `meetingNotesSchema` → `storedNotesSchema` at **both** read sites — `db/notes.ts:64`
(`notesReadRowSchema`) and `db/schema.ts:61` (`meetingRowSchema`). Writers only ever emit
v2. No backfill migration; rows upgrade naturally on the next regenerate. A one-shot
backfill script is optional later, never required.

`meetingNotesV1Schema` is the current schema frozen verbatim, marked "read-only; never
extend."

---

## 3. The fold — `modules/notes/live-fold.ts` (pure)

### What the model returns

```ts
const foldOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"),     list: listKey, item: <loose content> }),
  z.object({ op: z.literal("update"),  list: listKey, id: z.string(), item: <loose content> }),
  z.object({ op: z.literal("retract"), list: listKey, id: z.string(), reason: z.string() }),
]);

const foldResultSchema = z.object({
  ops: z.array(foldOpSchema).max(MAX_OPS_PER_FOLD),
  narrative: z.object({ title: …, tldr: …, overview: … }).partial().optional(),
  conversationType: conversationTypeSchema.optional(),
});
```

The model is shown a **digest** of prior notes — `id` + `text` only, no quotes, no
`deadlineRaw`, no `overview`. It needs to know what exists and under which id; it does not
need the payload back. This roughly halves input tokens and structurally prevents the model
from rewriting a retained item's quote.

### `applyFold(prior, modelOut, ctx) → { notes, changed, dropped }`

Pure, synchronous, fully unit-testable. It is where the non-teleport guarantee actually
lives — every rule below is a server-side clamp, not a prompt instruction:

1. **Churn ceiling.** At most `maxChurnPerFold` (default **3**, or 25% of a list, whichever
   is larger) `update`+`retract` ops may land per fold. Excess ops are **dropped and
   logged**. A model that returns a wholesale rewrite gets clamped to three changes.
   *This is the mechanical "never teleport", and it is adversarially testable.*
2. **Id reuse by echo.** `update`/`retract` against an id in the prior set → applies.
   Against an unknown id → dropped (not minted-as-new; an `update` to a hallucinated id
   is a model error, not an addition).
3. **Duplicate echoed ids.** Two ops against the same id in one fold → first wins, rest
   dropped. LLMs do this routinely.
4. **`add` mints.** Fresh id from a per-meeting, per-list counter (`d1`, `d2`, …). Never
   reuses a retracted id.
5. **Order is server-owned.** Items sort by mint sequence, never by the model's array
   order. The model cannot reshuffle a list.
6. **Retraction only on an explicit `retract` op.** An item omitted from the response is
   retained, always.
7. **Per-list cap.** `maxItemsPerList` (default **40**). At cap, `add` ops are dropped and
   the next prompt tells the model to consolidate via `update`. Bounds a 3-hour call.
8. **Narrative gating.** `narrative` is honoured only on folds where the narrative window
   is open (§4); otherwise the field is ignored server-side. `title` is **latched** after
   the first non-empty value and only replaced when `conversationType` changes.
9. **Conversation-type latch.** `casual → sales|interview` allowed once, past the classify
   threshold; any other transition is dropped.
10. **Quote verification.** The result runs through the existing pure `verifyNotes(notes,
    transcriptSoFar)` so live items carry the same `unverified` flag semantics as final
    ones.

Returns `changed: false` when every op was dropped — no rev bump, no wire event, no write.

### `reconcileIds(live, final) → MeetingNotes` (pure, new file)

Runs at the end of the post-call pipeline, before the notes are written. Matches final
items to live items per list by normalized-text similarity; a match carries the **live id**
onto the final item, everything else mints fresh. Result: the tab animates a diff instead of
replacing an hour of accrued notes. No LLM path changes.

*(Seeding the post-call reduce with the live notes — cheaper and probably higher quality —
is a real option, but it changes the map-reduce contract and risks the green accuracy
gates. Deferred; reconcile achieves the animation goal at a fraction of the risk.)*

---

## 4. The loop — `modules/live/notes-conductor.ts`

State: `prior: MeetingNotes | null` · `rev: number` · `delta: TranscriptTurn[]` ·
`seqCounters` · `foldsSpent` · `inFlight: AbortController | null` · `type: ConversationType`.

**Start.** Hydrate `prior`/`rev`/`seqCounters` from `live_notes` for this meeting; if a row
exists, emit one `notes.update` immediately so a reconnecting or mid-call-opened tab sees
current state without a REST round trip.

**Tick** (debounce `foldIntervalMs`, default **25s**), in order — each is cheaper than the
next:

1. `disposed` / `inFlight !== null` → **skip** (single in-flight latch; the delta keeps
   accruing). *This is what makes overlapping folds impossible.*
2. `foldsSpent >= maxFoldsPerSession` or quota exceeded → **stop the loop permanently.**
3. `delta.length < minUtterancesPerFold` → skip.
4. `notesTrigger(delta)` says quiet **and** `deltaTokens < maxDeltaTokens` → skip.
   (The token ceiling is a **force-fire**: a gate tuned toward quiet must never starve a
   diffuse-but-substantive stretch.)
5. Classify once, past `classifyMinTurns`, if still `casual` — one metered LLM call, latched
   after.
6. Build fold messages (prior digest + rendered delta + `TYPE_GUIDANCE` + `calendarTable`),
   call the router with `meterFor(userId, meetingId)` and the abort signal.
7. `applyFold` → if `changed`: `rev++`, persist, `send({type:"notes.update", notes, rev})`.
8. **Clear the delta only now** — only on a fold that validated.

**Delta lifecycle is the one thing that must not be gotten wrong.** The fold is stateful and
never re-reads the transcript, so anything consumed by a failed fold is lost forever. On
gate-no-fire, on LLM error, on abort, on schema reject, on `changed: false` → the delta is
**retained**. It clears at step 8 and nowhere else.

**Narrative window.** Open on every `narrativeEveryNFolds`-th fold (default 4 ≈ every 2 min),
or when item count changed by ≥ `narrativeItemDelta`. Otherwise the prompt omits the
narrative section and the reducer ignores it. Rewriting `tldr`/`overview` 144×/hour reads as
churn no matter how it is animated.

**Dispose.** Abort in-flight, drop the pending delta (the post-call pipeline reads the whole
transcript regardless — the last partial delta is not load-bearing), do **not** write. Runs
before the STT stop is registered so LIFO tears down in the right order, matching the
existing conductor.

Config lives in `notes-conductor-config.ts`, mirroring `conductor-config.ts` (zod, defaulted,
so tests drive tiny values under fake timers).

---

## 5. The gate — `modules/live/notes-trigger.ts` (pure)

Mirrors `trigger.ts` in shape but not in economics, and the difference matters:

- `trigger.ts` gates a **per-utterance** call, so a false fire is expensive and a false quiet
  is nearly free. It is tuned to stay quiet.
- The notes gate sits **behind a 25s debounce**, so the debounce is the real rate limiter.
  On a live sales call, "numbers, dates, named entities" fire on nearly every turn — the gate
  is a **small-talk suppressor**, not the cost control. Size expectations accordingly.
- Its false-quiet mode is genuinely dangerous in a way `trigger.ts`'s is not: a decision with
  no lexical cue ("yeah, let's do that") is invisible to a lexical heuristic. Mitigated by the
  §4 step-4 force-fire, not by the gate itself.

Fires on: commitment verbs, numerals/currency/percentages, dates and relative-time phrases,
proper nouns, question forms, negation-of-agreement, decision markers. Quiet on: pure
backchannel/pleasantry deltas (reuse `SMALL_TALK_PATTERNS` — extract to a shared module
rather than copy it). Returns `{ fire, reason }`.

---

## 6. Wire — `packages/shared/src/live.ts`

Additive, stays `v: 1`:

```ts
export const notesUpdateSchema = z.object({
  v: version,
  type: z.literal("notes.update"),
  notes: meetingNotesSchema,      // full v2 object; client diffs by id
  rev: z.number().int().nonnegative(),
});
```

No client→server event. **Additive is safe here**: `use-live-session.ts:256` does
`serverLiveEventSchema.safeParse(json)` and silently ignores failures, so a client older than
the server simply never sees notes — verified, not assumed. (A discriminated-union `safeParse`
*does* reject unknown `type`s; the tolerance comes from the `if (parsed.success)` guard.)

Client rule to document for Gustavo: **drop any `notes.update` whose `rev` ≤ the last seen
rev.** Cheap guard against out-of-order delivery across a reconnect.

---

## 7. Persistence — new table + `db/live-notes.ts`

```sql
create table public.live_notes (
  meeting_id  uuid primary key references public.meetings (id),
  user_id     uuid not null references public.profiles (id),
  notes       jsonb not null,
  rev         integer not null default 0,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index live_notes_user_id_idx on public.live_notes (user_id);
alter table public.live_notes enable row level security;

create policy live_notes_select_own on public.live_notes
  for select to authenticated using (user_id = auth.uid ());
-- NO insert/update policy or grant for `authenticated`: live notes are
-- SERVER-AUTHORED. The client reads; only service_role writes. (Contrast
-- meetings — see finding F1.)
grant select on public.live_notes to authenticated;
grant select, insert, update, delete on public.live_notes to service_role;
```

- Denormalized `user_id` for the flat RLS predicate, matching `transcripts`.
- Upsert on `meeting_id` with `rev` as an optimistic-concurrency guard
  (`where rev < $newRev`), through a **pg `Pool`**, not the supabase-js REST client —
  `db/notes.ts` uses the REST client, which is an HTTP round trip per write and the wrong
  tool for a per-tick path. `usageEventsDbFromEnv` already exposes a pool.
- One write per successful fold (~150/call, on a narrow dedicated table) needs no throttle.
- Add to the future `scripts/purge/` table list and any account-deletion sweep. (Neither
  exists yet — `db/account.ts` only soft-deletes `profiles` + files a `deletion_requests`
  row — but the table must be on that list when it is written.)

`notesReadResponseSchema` gains `live_notes: meetingNotesSchema.nullable()` and
`live_notes_rev: z.number().nullable()`. **`notes_status` semantics are untouched** — its
`none|queued|processing|completed|failed` meaning and the retry affordance keyed off it stay
exactly as they are. The tab prefers `notes` when non-null, else `live_notes`.

---

## 8. Metering, entitlement, wiring

**Metering.** `meterFor(userId, meetingId)` on both LLM sites (fold + classify), exactly like
the conductor. Extend `metering.audit.test.ts` with the new construction site. Note the audit
static-greps *top-level `function` blocks* in `app.ts` / `metering-wiring.ts` /
`live/routes.ts` — if the notes router is built **inside** the existing
`maybeCreateLiveConductorFactory`, the per-function assertion passes vacuously. Build it in
its own top-level `maybeCreateLiveNotesConductorFactory` and assert on it by name.

**Enforcement (not just recording).** `maxFoldsPerSession` hard ceiling, plus an
`isOverLlmQuota`-style check on the metering seam that stops the loop. Fail-closed: no
entitlement, no LLM key, no DB → the loop never starts, zero `notes.update`, zero spend.

**Entitlement.** `canUseLiveNotes(plan): boolean`, co-located with `modules/metering/config.ts`
next to the plan limits. `profiles.plan` is per-user and the factory is built once at boot
with no user (`metering-wiring.ts:169`), so the plan read is per-session. Resolve it **lazily
on the first tick**, not at `session.start` — the start path already chains concurrency →
daily cap → ownership → quota, and live notes must not add latency to it. Entitlement is
**latched at session start** (a RevenueCat downgrade mid-call does not kill an in-flight call).

**Wiring.** `LiveSession` gains a `LiveTranscriptConsumer[]` instead of a second hardcoded
conductor field:

```ts
interface LiveTranscriptConsumer {
  onPartial?(text: string, speaker: string | null): void;
  onFinal?(text: string, speaker: string | null): void;
  dispose(): void;
}
```

`onServerEvent` fans out; each consumer registers its own disposer entry. The copilot
conductor becomes consumer #1, notes conductor #2, and Phase 9 gets it free. Notes conductor
is skipped in `echo` mode, same as the copilot conductor.

---

## 9. Files

**New**
`modules/notes/live-fold.ts` · `modules/notes/reconcile-ids.ts` ·
`modules/notes/prompts/live-fold.ts` · `modules/live/notes-trigger.ts` ·
`modules/live/notes-conductor.ts` · `modules/live/notes-conductor-config.ts` ·
`db/live-notes.ts` · `supabase/migrations/*_create_live_notes.sql` · co-located `*.test.ts`
for each.

**Modified**
`packages/shared/src/notes.ts` (content/identified split, v2, `storedNotesSchema`,
`identifyNotes`, `upcastNotesV1`) · `packages/shared/src/live.ts` (`notes.update`) ·
`db/notes.ts` + `db/schema.ts` (union+upcast at both read sites) ·
`modules/notes/pipeline.ts:140` + `map-reduce.ts:387` (`identifyNotes` at assembly) ·
`modules/notes/handler.ts` or `worker.ts` (run `reconcileIds` before write) ·
`modules/notes/routes.ts` + `ports.ts` (read model exposes live notes) ·
`modules/live/session.ts` (consumer fan-out) · `modules/live/routes.ts` (wire the factory) ·
`metering-wiring.ts` (`maybeCreateLiveNotesConductorFactory`, `canUseLiveNotes`) ·
`metering/metering.audit.test.ts` · `docs/ARCHITECTURE.md` · `docs/DECISIONS/adr-0009-live-notes.md` ·
`CLAUDE.md`.

**Explicitly NOT touched:** `format.ts`, `ladder.ts`, any post-call **prompt**, `verify-quotes.ts`.
Mobile has no notes readers yet (`grep` confirms zero consumers of `meetingNotesSchema` in
`apps/mobile`), so v2 costs nothing on the client — this is the cheapest moment it will ever
be to make this change.

**RULES §6 (logging).** Fold error paths log **ids and shape only** — op counts, dropped-op
reasons, zod issue paths. Never the model's raw output, the notes object, or the delta: all
three contain transcript content. The instinct when debugging a schema reject is to log the
raw text; don't.

---

## 10. Verification

**Pure unit (the load-bearing tests).**
- `applyFold` churn ceiling: a model response that rewrites every item → at most
  `maxChurnPerFold` land, the rest are dropped and reported. *This is the non-teleport proof.*
- Id stability across a scripted 10-tick sequence: untouched item keeps id; `update`d item
  keeps id with new text; `add` gets a fresh id; `retract`ed disappears; retracted ids never
  reused.
- Adversarial model output: duplicate echoed ids · ids not in the prior set · ops against a
  list at cap · `retract` of an unknown id · reshuffled array order · a `sales → interview`
  type flip · narrative sent on a closed window. Every one is clamped, none throws.
- `upcastNotesV1` round-trip; `identifyNotes` determinism; `buildFallbackNotes` is v2-valid;
  `reconcileIds` carries live ids onto matching final items.
- Gate fixtures in the `trigger.test.ts` style: small-talk delta → quiet; commitment / number
  / date / decision-marker → fire.

**Loop (fake timers).** Overlapping ticks → second is skipped, delta accrues, one fold runs ·
LLM error → delta retained, no rev bump, no write · `changed:false` → no wire event · fold
budget exhausted → loop stops · dispose mid-fold → aborted, no write · hydration → one
`notes.update` at start.

**Schema/DB.** v1 rows still read after the v2 change (**the regression test for the bug the
first draft would have shipped**) · `live_notes` RLS: user A cannot read B's row, and
`authenticated` cannot write its own · optimistic `rev` guard rejects a stale write.

**Metering.** `metering.audit.test.ts` fails if either live-notes LLM site loses its meter.

**Wire/integration.** Scripted transcript over the real socket → monotonic `rev` series;
reconnect → hydrated state emitted; entitlement off → zero `notes.update` and zero usage
rows. Extends the `live.input.e2e.test.ts` style.

**Green gate.** `npm run check` with `npm run db:start`. Existing notes accuracy gates (5/5)
must stay green — they should be untouched, since no post-call prompt changes.

---

## 11. Non-goals

Real mic capture · the mobile UI and all animation (Gustavo) · changing the what-to-say
conductor · changing any post-call prompt · seeding the post-call reduce from live notes
(deferred, §3) · prompt caching / groq routing.

---

## 12. Open questions for Gustavo

1. **Typed input pollutes the notes** (finding F2 below). `transcript.input` is injected as a
   `transcript.final` from **"them"**, so a question you type *to your copilot* is recorded as
   something the other party said — and live notes will surface that in real time, visibly.
   Options: (a) add an optional `origin: "copilot_question" | "utterance"` to
   `transcript.input` and have the notes fold exclude copilot questions; (b) split the mobile
   UI into two affordances; (c) accept it. The server cannot classify this — only the client
   knows the user's intent. **(a) is my recommendation**, and it is additive.
2. **Exact plan mapping** for `canUseLiveNotes` — `pro` only, or a new tier?
3. **Cost re-check.** Ops-based folding cuts the dominant term, but a 60-min call is still
   ~140 folds × (prior digest + delta) input. Rough estimate on `gemini-3.5-flash-lite`
   ($0.30/$2.50 per 1M): **~$0.10–0.15/call**, vs ~$0.45+ for whole-object rewrite. Worth a
   look before the fold interval is finalized — 25s vs 40s is a near-linear cost lever.
4. **Fold interval default** — 25s is a guess. It is one config value; easy to tune against a
   real call.

---

## 13. Adjacent findings (out of scope, raised for the record)

**F1 — `public.meetings` carried a table-wide `grant update ... to authenticated`. FIXED
2026-07-25** (`20260725120000_tighten_meetings_grants.sql` + `db/meetings-grants.integration.test.ts`,
which proved the hole open before the migration and closed after: a real user JWT could
write `indexed_at`, `ended_at`, `notes_status`, `notes`, and smuggle server columns on
INSERT). Original writeup follows.
`create_meetings` (20260719215139) grants blanket UPDATE, and no later migration tightens it
— `20260723100000` fixed exactly this class of hole on `profiles` (blanket UPDATE → column-
scoped `display_name, deleted_at`) but did not touch `meetings`. Combined with
`meetings_update_own`, a user JWT can today write its own `notes`, `notes_status`,
`notes_generated_at`, `follow_up`, `ended_at`, and `indexed_at` straight through the Data
API — forging completed notes, or wedging the RAG sweeper by stamping `indexed_at`. Same
shape, same severity class as the profiles bug. Fix is the same one-line pattern:
`revoke update on public.meetings from authenticated; grant update (title, deleted_at) on
public.meetings to authenticated;`. **Its own migration and its own PR** — not smuggled into
this feature. It is also the reason §7 puts live notes in their own table with no
`authenticated` write grant.

**F2 — typed input is attributed to "them" and persisted.** `session.ts:251-269` routes
`transcript.input` through `onServerEvent` as a `transcript.final` with `speaker: "them"`,
which means it is echoed, fed to the conductor, **and written to `transcripts`**. So
copilot-directed questions already contaminate the post-call notes and the RAG index today —
live notes does not cause this, it makes it *visible*. See §12.1.

**F3 — no purge path exists yet.** RULES §3 points hard deletes at `scripts/purge/`, which
does not exist; `db/account.ts` soft-deletes `profiles` and files a `deletion_requests` row,
and nothing sweeps `meetings`/`transcripts`/`chunks`/`embeddings`/`usage_events`. Not this
feature's problem, but `live_notes` joins the list of tables that will need it.
