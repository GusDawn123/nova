# Design — Post-call notes pipeline (`modules/notes`)

> **STATUS: BUILT (Phase 5, `dev-claude-notes`, 2026-07-22)** — implemented as specced,
> live accuracy gates GREEN; evidence in PARITY rows 13–22, as-built shape in
> ARCHITECTURE "Built so far".
>
> Phase 5 build spec (LOOP_PLAYBOOK Phase 5, PARITY rows 13–22). Decisions and their
> "why" live in `DECISIONS/adr-0006-notes-pipeline.md`; this file is the build shape.
> Research-first design (2026-07-22): three parallel research passes — long-transcript
> summarization, Postgres-backed job queues, structured-output reliability across a
> vendor-agnostic failover router.

## What it does

When a call ends, `modules/notes` turns the meeting's final transcript into a
structured, zod-validated notes object — title, tl;dr, overview, decisions,
action items (owner + deadline), open questions, risks — shaped by conversation
type (sales / interview / casual), plus a copy-ready follow-up draft generated
FROM the notes object (never from the raw transcript). Notes are stored on the
meeting row, exposed over authed REST, and regenerable on demand. Generation is
a durable background job: crash-safe, retried with backoff, never silently lost.

## System shape

```
call ends (live session disposal)                    crash mid-call
  └─ markEnded stamps meetings.ended_at                └─ ended_at never stamped
       └─ EAGER enqueue (best-effort)                       └─ STALE-CALL REAPER stamps it
                                                                 (started_at old + ended_at null)
            ┌────────────────────────────────────────────────┐
            │  jobs table (kind='generate_notes')            │
            │  queued → processing → completed / dead        │
            │  claim: FOR UPDATE SKIP LOCKED  (atomic)       │
            │  crash-mid-job: lease expiry → reaper requeue  │
            │  backstop: sweep-enqueue (ended_at set, no job)│
            └───────────────┬────────────────────────────────┘
                            ▼
            NotesWorker (poll ~5s, one job per tick)
              1. load final transcript turns (ordered)
              2. classify conversation type   (small LLM call, fallback 'casual')
              3. generate notes:
                   fits budget → SINGLE-PASS  (default: everything < ~32k tokens)
                   over budget → MAP-REDUCE   (turn-boundary chunks → facts → merge)
              4. structured-output ladder: salvage → zod → 1 repair → fallback
              5. verify evidence quotes (substring vs transcript) → flag unverified
              6. persist: meetings.notes (jsonb) + notes_status='completed'
              7. usage metered per user (llm Meter port → job telemetry + logs)
```

## Module anatomy (`apps/server/src/modules/notes/`)

- `ports.ts` — module-local contracts + zod: `NotesJobStore` (claim/complete/retry/
  reap over the jobs table), `TranscriptSource` (final turns for a meeting),
  `NotesWriter` (persist notes + status), plus the pipeline config schema. The llm
  seam is the EXISTING `LlmRouter` port — notes never touches vendor SDKs.
- `worker.ts` — the poll loop (claim → process → complete/retry), lease heartbeat-free
  v1 (lease ≥ 2–3× worst job), exactly-once start/stop mirroring the RAG indexer.
- `pipeline.ts` — classify → generate (single-pass | map-reduce) → ladder → verify.
- `chunking.ts` — turn-boundary token-budget packing for the map step (notes-local;
  `modules/rag`'s chunker is retrieval-tuned and modules are islands).
- `ladder.ts` — buffer stream → deterministic salvage (fence extraction + `jsonrepair`)
  → zod parse → ONE repair round-trip → deterministic minimal fallback.
- `prompts/` — authored prompt content (system + per-type sections + repair + follow-up),
  original work (the Phase 7 verbatim-prompt constraint does NOT apply here).
- `follow-up.ts` — draft generator: input is the VALIDATED notes object only.
- `routes.ts` — authed REST: notes read / regenerate / follow-up.
- DB adapters live in `apps/server/src/db/` (`jobs.ts`, `notes.ts`, `stale-call-reaper.ts`)
  so no SDK/Pool detail enters the module (same seam style as `db/rag-indexer.ts`).

## Data model (one migration, expand-only)

`jobs` — the durable queue (service-role/pool only; RLS enabled, ZERO policies —
same posture as `deletion_requests`):

- `id uuid pk`, `kind text` (`'generate_notes'`), `meeting_id uuid fk`, `user_id uuid fk`
- `status text check in ('queued','processing','completed','dead')`
- `attempts int`, `max_attempts int default 5`
- `run_at timestamptz` (delayed retry: backoff lands here)
- `locked_at timestamptz`, `locked_by text` — the lease
- `last_error text`, `raw_output text` (failed generations keep the raw model text —
  malformed JSON lives HERE, never in a typed jsonb column)
- `usage jsonb` (per-attempt token usage — the Phase 6 metering seam)
- partial unique `(kind, meeting_id) where status in ('queued','processing')` —
  one active job per meeting per kind; completed/dead history preserved (regenerate
  = a fresh row)
- partial indexes on the claim set (`status='queued'` by `run_at`) and the reap set
  (`status='processing'` by `locked_at`)

`meetings` additions (read-model, nullable/defaulted — expand-only):

- `notes jsonb` — ONLY ever a zod-valid notes object (the ladder guarantees it)
- `notes_status text default 'none' check in ('none','queued','processing','completed','failed')`
- `notes_generated_at timestamptz`
- `follow_up jsonb` — latest follow-up draft `{tone, subject, body, generated_at}`

## The notes contract (`packages/shared/src/notes.ts`)

Shared wire schema — the mobile app renders this in Phase 8:

```ts
NotesSchema = {
  version: 1,
  conversationType: 'sales' | 'interview' | 'casual',
  title: string,           tldr: string,          overview: string,
  decisions:   [{ text, quote: string|null, unverified?: true }],
  actionItems: [{ text, owner: string|null,
                  deadline: string|null /* ISO date */, deadlineRaw: string|null,
                  quote: string|null, unverified?: true }],
  openQuestions: string[],
  risks: string[],
  typeInsights:            // the SHAPE difference between conversation types
    | { kind: 'sales',     objections: string[], buyingSignals: string[] }
    | { kind: 'interview', questionsAsked: string[], answersToRevisit: string[] }
    | { kind: 'casual' },  // no extra section
  source: 'generated' | 'fallback',
}
FollowUpSchema = { tone: 'professional'|'warm'|'brief', subject: string, body: string }
```

The deterministic fallback (constant, proven schema-valid by a unit test): meeting
title, `tldr: 'Automatic notes are unavailable for this call.'`, empty arrays,
`typeInsights: {kind:'casual'}`, `source: 'fallback'`. A fallback still completes the
job (`notes_status='completed'`); the UI can key a retry affordance off `source`.

## Generation decisions (research-backed)

- **Single-pass is the primary path.** A 90-min diarized call ≈ 18–23k tokens
  (~250–300 tokens/min); the gate is `maxSinglePassTokens` (default 32k ≈ 2h+ of
  audio, config-tunable — tests force the map-reduce path by lowering it). Above the
  gate: map-reduce with ~6k-token chunks cut ONLY at turn boundaries, ~15% overlap,
  map step extracts STRUCTURED facts (+ a 3-sentence mini-summary), reduce MERGES
  facts and writes title/tldr/overview from the ordered mini-summaries — never
  re-derives items from prose (that is where early-call facts die). Action-item dedup
  in reduce: normalized-text match v1 (embedding-similarity dedup is a logged upgrade).
- **Extraction is structured like a map step even in single-pass:** every decision /
  action item carries a verbatim `quote`; after parse, quotes are substring-verified
  (whitespace-normalized) against the transcript; failures are FLAGGED `unverified`
  (kept for recall, logged for observability) — the strongest cheap hallucination
  guard for commitments.
- **Owners** come from the diarized transcript (named if the transcript names them,
  else the speaker label); never invented. **Deadlines**: the prompt carries the call
  date + weekday; output is ISO `deadline` + verbatim `deadlineRaw`, BOTH null when no
  date was stated — the model never invents one.
- **Type classification** is a separate small LLM call over the transcript head
  (~first 2k tokens), zod-parsed enum; any failure → `'casual'` (the neutral shape).
  Type selects the generation prompt variant + `typeInsights` arm.
- **Follow-up drafts are generated from the validated notes JSON only** — the
  generator's input type does not admit a transcript, so cites-notes-only holds by
  construction and is asserted mechanically (the captured prompt contains no
  transcript content).

## Structured-output ladder (constitution §1, research-backed)

Portable prompt (works on whichever of the four vendors the router commits to):
system "respond with ONLY a JSON object, no prose, no fences" + compact TS-style
schema with per-field comments + ONE small example + trailing "ONLY the JSON object".
Then: buffer the router's stream → `JSON.parse` → else fence/brace extraction +
`jsonrepair` → zod `safeParse` → on failure ONE repair round-trip (schema + invalid
output + zod issue paths, "preserve valid content", may land on ANY healthy provider)
→ else the deterministic fallback. Raw failing text is stored on the job row
(`raw_output`), never in `meetings.notes`. Vendor-native JSON modes are NOT used in
v1 (Anthropic prefill is removed on current models; Groq's json_schema mode can't
stream) — an optional per-adapter hint is a logged Phase 7+ opener.

## Durability decisions (research-backed)

- **Queue = hand-rolled jobs table** (pg-boss/graphile auto-manage their own schemas —
  friction with migrations-as-SQL + RLS-ships-with-tables; graphile's crashed-lock
  default is 4h). Claim is one atomic `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
  LOCKED LIMIT 1) RETURNING *` — multi-instance-safe from day one (closes the Phase 6
  sweeper-claiming opener for THIS consumer).
- **Enqueue is belt-and-suspenders:** EAGER best-effort enqueue when `markEnded`
  stamps `ended_at` (fast path, seconds-level latency) + a SWEEP backstop (meetings
  with `ended_at` set, live, no notes and no active/completed `generate_notes` job →
  enqueue) so a crash between stamp and enqueue can never lose a meeting. Both are
  idempotent under the partial unique index.
- **Crash-mid-job:** lease expiry. Lease 10 min (≥2–3× worst job), reaper every ~30s:
  expired `processing` rows → `queued` (attempts kept) or `dead` when exhausted.
  At-least-once execution; the worker is idempotent (notes write is an upsert keyed
  by meeting, status transitions are guarded UPDATEs).
- **Retry policy:** error-classified. Transient (429/5xx/timeout/all-providers-down)
  → requeue with jittered exponential backoff (60s · 3^(attempts−1), cap 15 min).
  Permanent (empty transcript is NOT permanent — it produces fallback notes; missing
  meeting, ladder-exhausted-with-fallback-stored never retries) → terminal. Attempts
  ≥ max (5) → `dead` + `notes_status='failed'`. All lease/backoff/interval numbers are
  zod-config, injectable for tests.
- **Stale-call reaper** (closes the Phase 4 opener): every ~60s, meetings where
  `ended_at is null and deleted_at is null and coalesce(started_at, created_at) <
  now() − staleCallMaxAgeMs (default 6h)` get `ended_at` stamped — the normal RAG
  sweep AND notes enqueue then pick them up. Lives in `db/stale-call-reaper.ts`,
  wired in `app.ts` beside the RAG indexer (it feeds both consumers).

## REST surface (`routes.ts`, all behind `requireAuth`, user-scoped queries)

- `GET  /meetings/:id/notes` → `{ notes_status, notes, follow_up, generated_at }`
  (404 unknown/other-user/deleted meeting — same shape as not-found; no existence leak)
- `POST /meetings/:id/notes/regenerate` → 202 `{ status: 'queued' }` (idempotent: an
  active job → 409 typed `already_running`; completed/dead history stays)
- `POST /meetings/:id/follow-up` `{ tone }` → 200 with the draft (synchronous — one
  small LLM call from stored notes; 409 typed `notes_not_ready` when no notes yet)

## Verification map (playbook VERIFY BY → concrete tests)

| Bar | Test |
|---|---|
| Schema + repair + fallback ladder | unit: ladder walks salvage→zod→repair→fallback vs scripted mock provider; fallback constant parses |
| 3 fixture shapes + facts | key-gated live: hand-labeled sales/interview/casual fixtures → expected facts assert (owner "send proposal by Friday" + deadline), `typeInsights.kind` differs |
| Long call (map-reduce) | fixture-generated long transcript + lowered `maxSinglePassTokens` forces map-reduce; facts planted in FIRST and LAST 10 min both present (mock + key-gated live) |
| Recovery | integration: claim job, simulate worker death (no complete), tiny lease+reaper config → job requeued → completes; concurrent-claim race → exactly one winner |
| Follow-up cites notes only | mechanical: captured prompt ⊆ notes-object content, type-level no-transcript input; plus live fixture no-invented-commitments check |
| Cost logged | usage jsonb on job + structured log per user (Meter port capture) |
| Regenerate | endpoint tests: 202 + new job row; 409 while active |

Live fact-check gates are key-gated (`describe.skipIf` without LLM keys) exactly like
the Phase 2/3/4 gates — keys are already in `apps/server/.env`, so they RUN this phase.
STOP-WHEN guard: fixture fact-checks still failing after 4 prompt iterations → stop and
present outputs side-by-side (playbook law).
