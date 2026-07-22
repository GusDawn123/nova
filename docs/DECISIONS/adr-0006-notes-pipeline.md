# ADR-0006 — Post-call notes pipeline: queue, generation shape, output ladder

- **Status:** accepted (Phase 5, 2026-07-22)
- **Context:** LOOP_PLAYBOOK Phase 5 — the MVP hero. When a call ends, produce
  structured notes + a follow-up draft: durable (crash never loses a meeting),
  vendor-agnostic (the llm router may commit to any of four providers), and with
  malformed LLM output unrepresentable in the DB (RULES §1). Build spec:
  `DESIGN/notes-pipeline.md`. Decisions below are research-first (three parallel
  research passes, 2026-07-22: long-transcript summarization; Postgres job queues;
  cross-vendor structured output).

## 1. Durable queue = hand-rolled `jobs` table (FOR UPDATE SKIP LOCKED), not a library

pg-boss and graphile-worker auto-create and auto-migrate their own schemas — directly
against RULES §4 (timestamped SQL migrations are the source of truth, RLS ships with
tables); vendoring their generated SQL re-imports the problem on every upgrade.
graphile's crashed-lock recovery default is 4 hours (faster is a paid tier) — a
product-killing stall for "where are my notes?". pgmq is a message queue, not a job
system (no queryable per-meeting status, attempts, or backoff). At single-digit
jobs/minute the entire library value is ~100 lines of SQL+TS we write once against the
pg Pool we already run. Claim = one atomic `UPDATE … (SELECT … FOR UPDATE SKIP LOCKED
LIMIT 1) RETURNING *` — multi-instance-safe from day one. Revisit a library only if we
grow many queue kinds / cron / fan-out.

## 2. Jobs table for execution + `meetings.notes_status` as read model

Marker columns alone (the RAG indexer's shape) cannot express in-flight vs crashed,
retries/backoff, or job history (regenerate). The industry hybrid: `jobs` drives
execution (status/attempts/lease/backoff/dead-letter, one ACTIVE job per (kind,
meeting) via partial unique index; completed/dead rows are history), while the product
reads a denormalized `meetings.notes_status` without joining jobs. `jobs` is
service-role/pool-only: RLS enabled with zero policies (the `deletion_requests`
posture).

## 3. Delivery = at-least-once + idempotent worker; recovery = lease + reaper

Exactly-once with external side effects is fiction; we hold the standard contract:
exactly-once CLAIM within a lease window, at-least-once execution, idempotent effects
(notes write is an upsert keyed by meeting; status flips are guarded UPDATEs; a
re-run costs tokens, not correctness). Long-open-transaction recovery is wrong for
minutes-long LLM jobs (MVCC bloat, pinned connections), so: claim commits immediately,
lease 10 min (≥2–3× worst job), reaper every ~30s requeues expired `processing` rows
(or dead-letters at attempt cap). All numbers zod-config and injectable so the
recovery test runs in seconds.

## 4. Enqueue = eager best-effort + sweep backstop (never same-transaction)

`markEnded` writes via supabase-js (PostgREST), so a same-transaction enqueue would
force the live path onto the raw Pool. Instead: eager enqueue right after the stamp
(fast path), plus a sweep backstop (ended, live, un-noted meetings with no active or
completed `generate_notes` job → enqueue) so a crash between stamp and enqueue can
never lose a meeting. Both idempotent under the partial unique index. The same sweep
tick hosts the **stale-call reaper** (Phase 4 opener): `ended_at is null` and
`coalesce(started_at, created_at)` older than 6h (config) → stamp `ended_at`, which
feeds BOTH the RAG indexer and notes. Lives in `db/`, wired in `app.ts`.

## 5. Single-pass primary, threshold-gated map-reduce above ~32k tokens

A 90-min diarized call is ~18–23k tokens (~250–300 tokens/min) — comfortably
single-pass on 200k-context models; but effective context degrades well before the
advertised window (context rot / lost-in-the-middle), and itemized extraction (action
items) degrades first. Gate at `maxSinglePassTokens` = 32k (~2h+): above it,
map-reduce — ~6k-token chunks cut ONLY at speaker-turn boundaries, ~15% overlap, map
extracts STRUCTURED facts + a 3-sentence mini-summary, reduce MERGES facts (dedup:
normalized-text v1) and writes prose from the ordered mini-summaries — never
re-derives items from prose. Tests force the path by lowering the gate; prod keeps
90-min calls single-pass.

## 6. Quote-grounding: verbatim evidence, substring-verified, flag-don't-drop

Every decision/action item carries a verbatim transcript quote; post-parse we
substring-verify (whitespace-normalized) against the transcript. Verification failure
FLAGS the item `unverified` (kept for recall — the fixture-facts bar — logged for
observability) rather than dropping it. Deadlines: prompt carries call date+weekday;
output = ISO `deadline` + verbatim `deadlineRaw`, both null when unstated (the model
never invents dates). Owners come from diarized labels/named speakers only.

## 7. Output ladder: portable prompt → salvage → zod → ONE repair → constant fallback

The router may commit to ANY vendor, so nothing vendor-specific is load-bearing:
portable prompt (compact TS-style schema — ~4× fewer tokens than JSON Schema, equally
followed — + one example + "ONLY the JSON object"), buffer the full stream, then
deterministic salvage (fence/brace extraction + `jsonrepair`, syntactic only) → zod →
ONE repair round-trip (invalid output + zod issue paths + schema, "preserve valid
content"; any healthy provider) → deterministic schema-valid fallback constant
(`source:'fallback'`, empty arrays). Raw failing text lands in `jobs.raw_output`
(text), never in `meetings.notes` (jsonb) — malformed JSON is unrepresentable there.
Rejected: Anthropic assistant-prefill (removed on current Claude models); vendor JSON
modes as a dependency (Groq's can't stream; schema dialects diverge) — a per-adapter
optional HINT is a logged opener, additive only.

## 8. Type classification is its own small call; follow-up cites notes by construction

A cheap zod-parsed enum classification over the transcript head (~2k tokens) selects
the prompt variant + `typeInsights` arm (`sales`/`interview` get type-specific
sections; failure → `'casual'`, the neutral shape). The follow-up generator's input
type is the VALIDATED notes object — it cannot receive a transcript, so
"cites-notes-only" holds by construction and is asserted mechanically on the captured
prompt. Follow-up runs synchronously in the request (one small call); notes
regeneration is always a queued job.

## Consequences

- Phase 6 metering gains a ready seam: per-attempt usage lands in `jobs.usage` via the
  router's `Meter` port, per-user structured logs from day one.
- Phase 8 mobile reads `NotesSchema` from `packages/shared` (version field for wire
  evolution) and keys a retry affordance off `source:'fallback'` / `notes_status='failed'`.
- The stale-call reaper closes the crash-mid-call orphan hole for RAG too (the marker
  half becomes crash-safe end-to-end).
- Openers logged: embedding-similarity dedup for reduce; per-adapter JSON-mode hint;
  worker heartbeat (drop lease to 2–3 min) if 10-min worst-case recovery ever hurts.
