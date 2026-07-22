# CLAUDE.md — Nova

Guidance for AI coding agents working in this repo.

## What this is

**Nova** — a mobile AI call copilot. Phone mic (speakerphone/acoustic capture) →
streaming STT with diarization → live text suggestions + post-call structured notes,
grounded in per-user RAG memory. Company-held API keys; users pay subscription.
Silent text copilot: no TTS, no bots joining calls, transcript-only storage.

**Stack:** npm-workspaces monorepo — `apps/server` (Node/TS, Fastify),
`apps/mobile` (React Native + Expo), `packages/shared` (zod schemas/types),
`supabase/` (Postgres + RLS + pgvector migrations).

**Status: Phase 5 post-call notes built on `dev-claude-notes` (branched off `development`, which
carries Phases 0-4 via PRs #1-#5). `modules/notes` ships the MVP hero: a durable `jobs`-table
queue (`db/jobs.ts`, atomic `FOR UPDATE SKIP LOCKED` claim, lease+reaper crash recovery, sweep
backstop, migration `20260722120000`), the worker + handler, the classify → single-pass|map-reduce
→ structured-output-ladder (salvage → zod → one repair → deterministic fallback) → quote-verify
pipeline over the EXISTING llm failover router (its first wired consumer), the follow-up draft
generator (cites notes BY CONSTRUCTION — its input type admits no transcript), the authed REST
surface (`GET /meetings/:id/notes`, `POST .../regenerate` 202|409, `POST .../follow-up`
200|409|503, uniform 404 — no existence leak), the stale-call reaper (closes the Phase 4
crash-orphan hole), and per-user usage logging + `jobs.usage` jsonb (the Phase 6 metering seam).
GREEN: full mock/DB suites incl. kill-worker recovery + concurrent-claim race, the full loop
(markEnded → enqueue → worker → valid notes), route integration (real Postgres + real JWTs), AND
the live LLM accuracy gates (2026-07-22, one prompt round: sales/interview/casual fact-checks
incl. proposal-by-Friday owner+deadline, three distinct type shapes, long-call map-reduce
planted-facts — key-gated so keyless CI self-skips). New env: `NOTES_WORKER_ENABLED=true` opts
the background worker in (off by default; needs `SUPABASE_DB_URL` + ≥1 LLM key); the notes REST
surface needs only the Supabase + DB env.**
Phase 4 RAG memory is merged: `modules/rag` (chunker, four ports, Voyage + pgvector-hybrid-RRF
adapters, `RagService`, marker-and-sweep indexer over `chunks`/`embeddings`, halfvec 1024 HNSW).
GREEN incl. the freshness bar (~0.7s vs <60s), the store latency bar (`npm run bench:rag` p95
7.2ms vs <300ms), and the LIVE Voyage smoke + top-3 retrieval accuracy gates (2026-07-22 —
`acme-pricing` #1 both tiers, user-B isolation 0 snippets, all rows `voyage-4`/1024). Voyage 429s
retry with backoff on the background tier only; query embeds stay fail-fast (adr-0005 §8).
Phase 3 streaming STT gateway is done and merged: live accuracy gates RAN and GREEN (word-overlap
87.8–96.3% vs 80/70 bars, both vendors ≥2 speakers, dead-vendor failover proven; turn-boundary
alignment per-vendor, real-audio re-test rides Phase 9). Phase 2 `modules/llm` live smoke PASSED
(anthropic + openai + google on `gemini-2.5-flash`; groq unkeyed → skips). The live-call spine —
the shared WebSocket wire protocol (`packages/shared/src/live.ts`), an authenticated `GET /live`
socket + per-call `LiveSession` (`modules/live/`), and the `modules/stt` failover/reconnect/silence
engine (AssemblyAI + Deepgram adapters) — all lives in this tree; raw audio is **never persisted**
(static + runtime `[no-disk]` audits). All vendor keys (STT, LLM, Voyage) are OPTIONAL: the server
boots without them and the affected path degrades to a typed error. Phase 1 carry-overs still hold:
Apple/Google sign-in deferred (needs Gustavo's dev accounts), Supabase **local-only** (cloud project
deferred), iOS-simulator verification deferred (Expo web + Playwright instead). Phases 6+ of
`docs/LOOP_PLAYBOOK.md` build the rest of the product on top.

## Read before doing ANYTHING

1. `docs/RULES.md` — the engineering constitution. Binding. Highlights:
   - zod-parse every boundary; TS strict; no `any`
   - vendor SDKs ONLY inside `modules/*/adapters/`
   - soft delete always (`deleted_at`); hard delete only in `scripts/purge/`
   - migrations: expand→backfill→contract, never edit applied ones, RLS ships with tables
   - every PR updates the living docs it affects (ARCHITECTURE / PARITY / ADR / this file)
2. `docs/ARCHITECTURE.md` — system shape, module map, invariants
3. `docs/LOOP_PLAYBOOK.md` — the phased build plan; work happens as loop phases
4. `docs/GIT_WORKFLOW.md` — branches development→staging→main, guards, `GusDawn123`
   account. Feature work: branch `dev-<who>-<topic>` off `development`, PR back into
   `development` ONLY (never staging/main), merge development INTO the feature to
   update (never the reverse), re-test, push. Merge commits only; branches survive
   merge. AI PRs (`dev-claude-*`) wait for Gustavo's go-ahead to merge.

## Hard prohibitions

- **NEVER read, copy, or transcribe from `~/Documents/natively-cluely-ai-assistant`.**
  Personal-use license; legally off-limits for this commercial product (RULES §9).
  If you need to know "how X works," derive from public patterns and docs/ specs here.
- No secrets in the repo. No vendor keys in the mobile app, ever.
- No unmetered paths to paid vendor APIs is the target; today metering is partial —
  LLM has an optional meter port, RAG's Voyage adapter has an ad-hoc usage sink, STT is
  unmetered. A unified `modules/metering` is tracked for Phase 6 and must land before real traffic.
- Never claim "done" without the phase's mechanical verification passing.

## Commands

Keep this current in the same PR that changes a script. Node >=22, npm >=10 (workspaces).

```
# Root (whole monorepo)
npm run check          # typecheck + lint + test — the mergeable=green gate
npm run typecheck      # tsc -b (server + shared) then apps/mobile tsc --noEmit
npm run lint           # eslint . then apps/mobile expo lint
npm run test           # vitest run (DB integration tests self-skip unless Supabase is up)
npm run format         # prettier --write .   (format:check to verify only)

# Local Supabase (real Postgres — never test against anything else)
npm run db:start       # supabase start  (boots the local stack)
npm run db:stop        # supabase stop
npm run db:reset       # supabase db reset  (re-applies migrations from scratch)

# Server workspace (apps/server, Fastify)
npm run dev   --workspace apps/server   # tsx watch — GET /health => { ok, version }
npm run start --workspace apps/server   # node dist/index.js (after a build)
npm run bench:rag --workspace apps/server  # RAG store p95 latency bar (DB-required, no
                                           #   vendor key). Needs the stack up + its env
                                           #   exported: `eval "$(supabase status -o env)"`
                                           #   then SUPABASE_DB_URL/URL/SERVICE_ROLE_KEY.
                                           #   Seeds 40k chunks, prints p50/p95/max vs <300ms,
                                           #   non-zero exit on FAIL, cleans up after itself.

# Mobile workspace (apps/mobile, Expo)
npm run start --workspace apps/mobile   # expo start (add --web / --ios / --android)

# STT test fixtures (rare; needs macOS `say` + ffmpeg). Regenerates the committed
# two-speaker WAVs under apps/server/fixtures/stt/ for the key-gated accuracy suite.
./scripts/make-stt-fixtures.sh
```

CI (`.github/workflows/ci.yml`) runs, on every PR: typecheck, lint, then boots the local
Supabase stack (`supabase start` — which replays every migration, the **shadow migration
replay**) BEFORE the test step, so the DB integration suites (RLS isolation, /me, /account)
run against real Postgres instead of self-skipping. `npm run check` is the local mirror
(typecheck + lint + test; run `npm run db:start` first for the same integration coverage).

## Conventions

- Branches: `dev-<who>-<topic>` (e.g. `dev-claude-rls-policies`); scripts verb-first
  (`backfill_*`). Style rules: docs/RULES.md §10 (Prettier + typescript-eslint
  strict-type-checked; discriminated unions over boolean flags; async/await only;
  screens dumb / hooks smart; tokens-only styling; snake_case SQL)
- Module anatomy: `ports.ts / adapters/ / service.ts / routes.ts`; module-local zod
  lives in `ports.ts` (shared wire types in `packages/shared`); tests are co-located
  `*.test.ts` beside the code; fixtures under `apps/server/fixtures/`
- Soft cap ~400 lines/file — split before you blow past it
- Structured errors + logs with `request_id`/`user_id`; never log secrets or raw
  transcripts at info level
