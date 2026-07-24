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

**Status: Phase 6 metering/quotas/billing built on `dev-claude-metering` (branched off
`development@9407425`, which carries Phases 0-5 via PRs #1-#6). `modules/metering` is now REAL:
the append-only `usage_events` ledger (migration `20260722130000`, select_own RLS, service-role
writes, priced at write time from a zod price book), per-call llm meters (`stream(req, {meter})`
+ `meterFor(userId, meetingId)` threaded through the notes pipeline, follow-up, and the Voyage
sinks — the static audit `modules/metering/metering.audit.test.ts` proves no vendor path runs
unmetered), live STT billed by relayed bytes (spans flush on vendor switch/disposal/quota tick,
±5% fixture bar), plan quotas over `profiles.plan` free|pro (session start + mid-stream →
typed `quota_exceeded` close; notes claim → dead-letter; follow-up → 429), REST rate limiting
(@fastify/rate-limit 100/min, `/live` excluded), ONE live session per user (typed
`concurrent_session`), the $50/day global kill-switch (refuse-new/finish-in-flight, one alert
per UTC day — the external-TestFlight gate, E2E-proven against a seeded ledger), the llm
`invalid` error class (400/404/422 → failover once + breaker counts; the anthropic credit-400
fix), and the token-gated RevenueCat webhook (fixture-proven free→pro/downgrade/idempotent;
live RC account = Phase 8/Gustavo). Session-start gate order: concurrency → daily cap →
ownership (fail-CLOSED) → quota (fail-OPEN — ratified posture, adr-0007 amendments). GREEN
2026-07-22 stack-up: 617 passed / 19 skipped / 0 failed. New env: `REVENUECAT_WEBHOOK_TOKEN`
(optional — unset means the webhook route does not exist).
ANTHROPIC IS DISABLED (2026-07-22 cost decision): the adapter/config/smoke code is KEPT and the
price book still prices claude-haiku-4-5, but the key is commented out in `apps/server/.env` —
the factory builds no anthropic provider and its live smoke self-skips. Re-enable = uncomment
the key. Working LLM set: OpenAI + Google (groq unkeyed).**
**Phase 7 live copilot loop is built on `dev-claude-live-copilot` (branched off `development`
after Phase 6). NEW: the llm `latencyTier: "live"` cheapest-first cascade (`liveOrder`
google→groq→openai→anthropic + `liveLlmConfig()` tight TTFT/stall — reasoning stays OFF at the
adapter layer); `modules/prompt` — one pure `assemble(mode, context) → { stablePrefix,
dynamicSuffix }` over Gustavo's VERBATIM system prompt (extracted byte-for-byte from
`docs/prompts/nova-prompts-source.md` by `scripts/gen-live-prompt.mjs` into
`content/system-prompt.ts`; byte-stable prefix snapshot-pinned; dynamicSuffix = hard-guarded user
context + RAG snippets under a token budget + windowed transcript LAST); `modules/live` conductor
(`conductor.ts` + pure `trigger.ts`/`speculation.ts`) — rolling transcript, tiered trigger gate
OFF the LLM hot path (quiet in small talk), speculation on confident partials with jaccard
adopt-or-discard reconcile (never a zombie), streaming suggestion.start/delta/done coalesced
~50ms/batch, deadline-ladder active abort, RAG grounding raced against a deadline (shrink, never
delay), threading `metering.meterFor`. Wired into `LiveSession` (a `createConductor` factory built
by `metering-wiring.ts::maybeCreateLiveConductorFactory`, consumed in `modules/live/routes.ts`);
the static metering audit gained a live-router case (no unmetered live LLM path). NEW (Gustavo's
2026-07-22 follow-up): the `transcript.input` typed-utterance wire event (additive) — the server
treats typed text exactly like a final "them" STT utterance (echo down + conductor + persistence;
`input_before_start` before ready; no new vendor site — rides the metered conductor path). Mobile:
`use-live-session` owns socket+meeting+state — PRIMARY path `start()` creates a meeting via the
supabase seam and connects the REAL authed socket, `sendInput()` asks typed questions and gets
REAL streamed answers; the copilot surface is a scrollable HISTORY (start APPENDS an entry,
deltas stream into it once/frame, discard removes only that entry, auto-scroll pinned unless the
user scrolled up), compact transcript strip on top, scripted replay demoted to a labeled
secondary button. Real mic capture is Phase 8/9; durable copilot-history context = Phase 8+
design item (see DESIGN/live-pipeline.md §Mobile). GATES (2026-07-22): latency
question→first-token p50=800ms p95=1450ms (<2000/<4000), speculation-hit p50=0ms (<500),
final→visible p50=800ms (<1500); relevance 9/10 (bar ≥7, OpenAI+Google); grounding contains the
stored `$47,500` fact (Voyage+DB); quiet 11/11 small-talk silent; typed-input E2E over the real
socket+LLM: deltas=6, answer_len=883, echoed as "them", persisted (~1.9s). Live gates are
key-gated (skipIf) — keyless CI self-skips.
ROLES (2026-07-23, adr-0008): `profiles.role` developer|admin|customer (migration
`20260723100000` — which ALSO fixes a live privilege hole: profiles UPDATE re-granted
column-scoped `display_name, deleted_at` only, so a user JWT can no longer self-set
plan='pro'/role='admin'; proven in `db/profiles-grants.integration.test.ts`). Seams:
`db/roles.ts` RoleReader (missing/deleted → 'customer'; DB error rejects), `/me` gains
optional `role` (display, best-effort), `plugins/role.ts` `createRequireRole` (403 fail
CLOSED, 503 unwired, no consumers yet), `scripts/set_user_role.ts <email|uuid> <role>`
(service-role assignment; auto-loads apps/server/.env). Mobile: `use-role` (resolves
'customer' until proven — no flash) hides the "Test Live" tab (renamed from "Live",
label-only — route file stays `live.tsx`) for customers via the SDK 57 native-tabs
`hidden` prop.**
Phase 5 (`modules/notes`, merged via PR #6): the durable `jobs` queue (SKIP LOCKED claim,
lease+reaper recovery, sweep backstop), classify → single-pass|map-reduce →
structured-output-ladder → quote-verify pipeline, follow-up drafts (cites notes by
construction), the authed notes REST surface (uniform 404, 202|409, 200|409|503), the
stale-call reaper. Live LLM accuracy gates green 2026-07-22. `NOTES_WORKER_ENABLED=true` opts
the background worker in (off by default; needs `SUPABASE_DB_URL` + ≥1 LLM key).
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
- No unmetered paths to paid vendor APIs — **DONE and audit-enforced as of Phase 6**: the
  unified `modules/metering` is live (llm per-call meters, STT relayed-byte spans, Voyage
  embedding/rerank sinks all land in `usage_events`), and the static wiring audit
  (`modules/metering/metering.audit.test.ts`) fails the build if any vendor construction
  site loses its sink or `noopMeter` reappears in production wiring. Keep it that way:
  new vendor paths MUST thread the metering seam and extend the audit.
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
