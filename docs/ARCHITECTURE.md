# Nova — Architecture

> **Living document.** Updated in the same PR as any change to structure, data model,
> or data flow (RULES.md §8). Describes the present; the "why" lives in `DECISIONS/`.
>
> **Status: Phase 6 metering/quotas/billing built on `dev-claude-metering` (branched off
> `development@9407425`, which carries Phases 0-5 via PRs #1-#6). Phase 6 adds the REAL
> `modules/metering`: the append-only `usage_events` ledger (migration `20260722130000`,
> select_own RLS, service-role-only writes) priced at write time from a zod price book; per-call
> llm meters (`stream(req, {meter})` + `meterFor(userId, meetingId)`) so every notes/follow-up
> token lands attributed; live STT billed by relayed bytes (spans flushed on vendor switch /
> disposal / quota tick); plan quotas (`profiles.plan` free|pro) enforced at session start,
> mid-stream, notes claim, and follow-up; REST rate limiting (@fastify/rate-limit, live WS
> excluded); a one-live-session-per-user registry; the $50/day global spend kill-switch
> (refuse-new / finish-in-flight, one alert per UTC day); the llm `invalid` error class
> (400/404/422 — the anthropic credit-outage fix); and the token-gated RevenueCat webhook
> mapping fixture purchases onto `profiles.plan`. What runs GREEN (2026-07-22, stack up):
> 617 passed / 19 skipped / 0 failed incl. the ±5% STT accuracy bar, EXACT llm-token
> passthrough, the seeded-ledger kill-switch E2E (the external-TestFlight gate), the RLS
> posture suites, and the static no-unmetered-vendor-path audit. Anthropic is DISABLED by
> decision (2026-07-22, cost): code kept + priced, key commented out — its live smoke
> self-skips.** Phases 0-5 remain as merged: auth + RLS isolation, the llm failover router,
> the live STT gateway, per-user RAG memory, and the post-call notes pipeline (all live gates
> ran green 2026-07-22; see the per-phase blocks below).**
> **Phase 7 live copilot loop is built on `dev-claude-live-copilot`** (off `development` after
> Phase 6): the llm `latencyTier: "live"` cheapest-first cascade, the pure verbatim-prompt
> `modules/prompt`, the `modules/live` conductor (rolling transcript + tiered trigger gate off the
> LLM hot path + speculation adopt-or-discard reconcile + ~50ms-coalesced streaming + deadline-
> ladder active abort + RAG grounding raced against a deadline), and a minimal mobile streaming
> pane. Every new vendor call threads `metering.meterFor` (the static audit gained a live-router
> case). Gates green 2026-07-22: latency question→first-token p50=800ms / p95=1450ms,
> speculation-hit p50=0ms, relevance 9/10, grounding contains the stored `$47,500` fact, quiet
> 11/11 silent — see the Phase 7 block below.

## What Nova is

A mobile AI call copilot. It listens during phone calls / meetings / in-person
conversations via the phone's microphone (speakerphone for calls), live-transcribes
with speaker diarization, and gives the user (a) real-time text suggestions during the
conversation and (b) structured notes + follow-up drafts after it ends — grounded in a
per-user RAG memory ("full context on your life").

**Interaction model:** silent text copilot. Nova never speaks, never joins calls as a
bot, stores transcripts only (never audio).

## System shape

```
┌─────────────────┐   audio stream (WS)    ┌──────────────────────────┐
│  apps/mobile     │ ─────────────────────▶ │  apps/server (Node/TS)   │
│  React Native    │ ◀───────────────────── │                          │
│  + Expo          │  transcripts,          │  modules/                │
│                  │  suggestions, notes    │   auth      sessions     │
│  thin client:    │        (WS + REST)     │   stt       llm          │
│  mic capture, UI │                        │   rag       notes        │
└─────────────────┘                        │   metering               │
        │ Supabase Auth (JWT)              └────┬────────────┬────────┘
        ▼                                       │            │
┌─────────────────┐                             │            ▼
│    Supabase      │ ◀───────────────────────────┘   ┌────────────────┐
│  Postgres + RLS  │      service-role access        │  AI vendors     │
│  pgvector        │                                 │  STT: AssemblyAI│
│  Auth, Storage   │                                 │   (Deepgram fb) │
└─────────────────┘                                 │  LLM: Anthropic,│
                                                    │  OpenAI, Google,│
                                                    │  Groq (routed)  │
                                                    └────────────────┘
```

Key invariants:
1. **The phone is thin.** Mic capture + UI only. No vendor keys, no business logic.
2. **All vendor spend flows through `metering`.** No unmetered path to a paid API.
   **HELD as of Phase 6, with evidence:** the static wiring audit
   (`modules/metering/metering.audit.test.ts`) asserts every llm-router construction
   site threads `meterFor`, every RAG construction site passes the usage sink, the
   live transport wires the STT usage seam, and `noopMeter` appears nowhere in the
   production wiring; the E2E accuracy suite proves the rows actually land.
3. **Per-user isolation is enforced by Postgres RLS**, not app code, and proven by
   A/B tests in CI.
4. **Streaming commit-point rule:** once a provider yields its first token to a user,
   we never switch providers mid-response.
5. **Raw audio is never persisted.** Transcript-only storage.

## Repository layout (monorepo, npm workspaces)

```
nova/
├── CLAUDE.md                  # AI-agent guide: commands, gotchas, rules pointer
├── README.md                  # onboarding entry point
├── docs/
│   ├── ARCHITECTURE.md        # this file (living)
│   ├── RULES.md               # engineering constitution
│   ├── PARITY.md              # feature-parity checklist vs reference product
│   ├── GIT_WORKFLOW.md        # branches, environments, guards
│   ├── LOOP_PLAYBOOK.md       # phased build loops
│   ├── DECISIONS/             # ADRs: adr-0001-stack.md, ...
│   └── RUNBOOKS/              # ops: deploy, rollback, purge, incident
├── apps/
│   ├── mobile/                # Expo app
│   │   ├── app/               # expo-router screens
│   │   ├── components/ui/     # app-agnostic primitives
│   │   ├── features/          # live-call, history, notes, context, paywall
│   │   ├── theme/tokens.ts    # ALL colors/spacing/type
│   │   └── lib/               # api client, ws client, auth session
│   └── server/
│       └── src/
│           ├── app.ts         # Fastify wiring, boot-time env parse
│           ├── modules/
│           │   ├── auth/      # JWT verify middleware, account deletion
│           │   ├── live/      # WS transport + LiveSession + Phase-7 conductor
│           │   │              #   (trigger gate, speculation, streaming suggestions)
│           │   ├── stt/       # ports.ts, adapters/{assemblyai,deepgram}, gateway
│           │   ├── llm/       # ports.ts, adapters/{anthropic,openai,google,groq},
│           │   │              #   router (fallback race, breaker, latencyTier)
│           │   ├── prompt/    # pure assemble(mode,context); verbatim system prompt
│           │   ├── rag/       # ports.ts (Chunker/Embedder/VectorStore/Reranker),
│           │   │              #   adapters/pgvector, service
│           │   ├── notes/     # post-call pipeline, schemas, job queue, recovery
│           │   └── metering/  # usage events, quotas, kill-switch, RevenueCat hooks
│           └── plugins/       # logging (request_id), error mapper
├── packages/
│   └── shared/                # zod schemas + types used by BOTH apps
│       ├── schemas/           # api/, ws-events/, notes/, config/
│       └── constants/
├── supabase/
│   ├── migrations/            # timestamped SQL (RULES.md §4)
│   ├── seed.sql               # local-dev fixtures only
│   └── config.toml
├── scripts/
│   ├── backfills/             # verb-first, idempotent, batched
│   ├── purge/                 # the ONE place hard-delete exists
│   └── seed_*.ts              # operational seeds (plans, prompts)
└── .github/
    ├── workflows/             # ci.yml, deploy-staging.yml, deploy-prod.yml
    └── PULL_REQUEST_TEMPLATE.md
```

Module anatomy (every server module follows it):
```
modules/<name>/
├── ports.ts        # interfaces + module-local zod (shared wire types in packages/shared)
├── adapters/       # vendor implementations of ports (ONLY place SDKs are imported)
├── service.ts      # business logic, exported interface for other modules
└── routes.ts       # HTTP/WS surface, zod-parsed in and out
# tests are co-located as *.test.ts beside the code; fixtures live in apps/server/fixtures/
```

### Built so far (Phase 0 scaffold + Phase 1 auth + Phase 2 LLM router + Phase 3 STT gateway + Phase 4 RAG memory + Phase 5 post-call notes + Phase 6 metering)

The tree above is the target. What exists today is the skeleton, the `/health` vertical
slice, the **Phase 1 auth domain**, the **Phase 2 LLM provider router**, the **Phase 3
live-call STT gateway**, the **Phase 4 RAG memory**, the **Phase 5 post-call notes
pipeline**, and the **Phase 6 metering/quotas/billing layer** — all below. Every server
product module now exists; the mobile `features/` (paywall states, product screens) are
not built yet (Phase 8).

Two structural deviations from the drawing, both intentional:

- **Mobile lives under `apps/mobile/src/`** (`src/app/`, `src/components/`,
  `src/hooks/`, `src/lib/`, `src/constants/`) — Expo's `src/`-rooted template — not at the
  workspace root as drawn. The `features/` and `theme/tokens.ts` folders arrive with the
  product screens; `src/constants/theme.ts` is the current token home.
- **Server is `apps/server/src/{app.ts, env.ts, index.ts, auth/, db/, plugins/, modules/}`** —
  the auth/health surface is still flat slices (`auth/verify-token.ts` token boundary +
  `plugins/auth.ts` the `requireAuth` preHandler, matching the request-id-plugin posture; `db/`
  wraps supabase-js behind an optional-env port), while the `modules/<name>/` anatomy is built
  out for real: **Phase 2's `modules/llm/` was the first slice** to that anatomy, and **Phase 3
  joined it** with `modules/stt/` and `modules/live/` (see the Phase 2 LLM router and Phase 3 STT
  gateway below). A formal `modules/auth/` lands when the rest of the product modules do.

**Auth data model (Phase 1 — live):** five migrations in `supabase/migrations/`. Every
user table enables RLS in the same migration that creates it (RULES §4.9) and grants are
scoped to `service_role` (+ `authenticated` where a policy needs it), since this stack does
not auto-expose new tables to the Data API.
- `profiles` — 1:1 with `auth.users` (`on delete cascade`), auto-provisioned by a
  `security definer` trigger on user signup; RLS `select`/`update` own only (no client
  insert/delete); soft-delete via `deleted_at`.
- `meetings` / `transcripts` / `context_docs` — user-owned tables, RLS own-rows-only, FK to
  `profiles(id)` with `NO ACTION` (so the purge worker deletes children before the auth row).
- `deletion_requests` — the account-deletion purge queue. RLS enabled with **zero policies**
  (server/`service_role` only); `processed_at` is a lifecycle column, not a soft-delete
  tombstone. The purge-worker FK-ordering contract (deepest child first, every FK
  `NO ACTION`) — the CANONICAL order as of Phase 6 is: **usage_events → embeddings →
  chunks → transcripts → jobs → meetings → context_docs → deletion_requests →
  auth.users** — the Phase 6 `usage_events` ledger (→ profiles / meetings, both
  `NO ACTION`) purges FIRST, the Phase 4 RAG tables (`chunks` → meetings / context_docs /
  profiles; `embeddings` → chunks / profiles) BEFORE the meetings/context_docs they hang
  off, and the Phase 5 `jobs` table (→ meetings / profiles) BEFORE the meetings its rows
  reference — otherwise the parent deletes fail on child FKs. NOTE: applied migration
  headers are law and are not edited (RULES §4), so older headers carry older phrasings —
  `create_deletion_requests` predates RAG/jobs/usage_events and lists the short order,
  and the `usage_events` header (`20260722130000_create_usage_events_and_plan.sql`) lumps
  "chunks/embeddings" in one breath — THIS DOC carries the canonical current contract.
  **Resolved (Phase 3, migration `20260720150000_enforce_transcript_parentage.sql`):** the
  original transcript write policies checked only `user_id = auth.uid()`, not that the referenced
  `meeting_id` belonged to the writer — so an authenticated user could insert a transcript they
  own against ANOTHER user's meeting, and that foreign child blocked the victim's `meetings`
  delete (FK `23503`) and wedged their purge. The migration tightens both the INSERT and UPDATE
  with-check to require the parent meeting to EXIST, be owned by `auth.uid()`, and be live
  (`deleted_at is null`), closing the re-parenting hole on writes (the `user_id = auth.uid()`
  ownership check is kept alongside the added `EXISTS` parentage guard). Proven by the A/B tests
  in `apps/server/src/db/transcript-parentage.integration.test.ts` (`[parentage-spoof]` rejects a
  cross-user parent, `[parentage-happy]` allows an own live meeting, `[parentage-soft-deleted]`
  rejects a tombstoned parent).
  **Fully guarded on BOTH write paths (Phase 4 review C1):** the RLS `with_check` above covers only
  Data-API/JWT writes; the live product write path (`modules/live` → the service-role
  `TranscriptPersister` in `db/transcripts.ts`) BYPASSES RLS, so it is guarded independently by an
  in-session ownership check — at `session.start`, before any STT starts or any transcript is
  written, `verifyMeetingOwnership` confirms the client-supplied `meeting_id` names a live meeting
  owned by the authenticated caller (missing/wrong-owner/tombstoned → typed `meeting_forbidden`
  error + policy-close; a DB error fails CLOSED). Enforced only when a persister is wired (a
  keyless/DB-less dev session streams without persistence and thus without the guard). Proven by the
  DB-gated A/B case in `apps/server/src/modules/live/live.auth.integration.test.ts`
  (`[ownership-spoof]`: B cannot open a session on A's meeting and no transcript row lands) plus the
  `session.test.ts` unit guard tests. Net: the product write path is now guarded by the in-session
  ownership check (service-role writes) AND the RLS `with_check` (Data API).

**Server auth layer (Phase 1 — live):**
- `auth/verify-token.ts` — the only module that knows how a Supabase access token is
  validated: **ES256 via remote JWKS** (`createRemoteJWKSet`, keys cached, no per-request
  network), alg pinned, audience `authenticated`, `exp` required; the server holds no signing
  secret. Returns a discriminated `{ valid }` result; the payload (`sub` uuid, optional
  `email`) is zod-parsed. (Deviation from the original HS256 plan — the local CLI issues
  ES256/JWKS; a legacy fallback would touch only this file.)
- `plugins/auth.ts` — `requireAuth` preHandler: `SUPABASE_URL` unset → **503** (server
  misconfig, not a client fault); no/invalid token → uniform **401**; valid → decorates
  `request.user`.
- `app.ts` routes — public `GET /health`; protected `GET /me` and `DELETE /account` (202
  `queued`). `db/account.ts::queueAccountDeletion` idempotently enqueues, tombstones the
  profile, and best-effort-revokes sessions. Dev CORS is localhost-only with `DELETE`
  explicitly allowed (the preflight for `DELETE /account` needs it).

**Mobile auth (Phase 1 — live):** `lib/supabase.ts` is the single vendor seam (zod-parsed
`EXPO_PUBLIC_*` config, `null` when unconfigured, platform-conditional session storage —
web `localStorage`, native AsyncStorage — both persisting across restart). `hooks/use-auth.tsx`
exposes a discriminated `AuthState` (`loading`/`unavailable`/`signed-out`/`signed-in`) +
`signUp`/`signIn`/`signOut`; `hooks/use-me.ts` and `use-delete-account.ts` call the server.
Screens are split into `(auth)/` (sign-in, sign-up) and `(app)/` (home, explore) route groups,
each with a layout guard that redirects on session state. **Apple/Google sign-in is deferred**
(needs Gustavo's dev accounts) — the provider seam is documented in `use-auth.tsx`.

Supabase is **local only** (`supabase/config.toml` + the migrations above). The `nova-dev`
cloud project is deferred to Gustavo; CI boots the local stack before the test step, so the
RLS A/B isolation test (`db/rls-isolation.integration.test.ts`) proves per-user isolation
against real Postgres on every PR. iOS-simulator verification is deferred (no simulator on the
build machine) — auth flows were proven via Expo web + Playwright instead.

**LLM provider router (Phase 2 — merged into `development` via PR #3, pending live smoke):**
`apps/server/src/modules/llm/` — the first slice built to the `modules/<name>/` anatomy
(ports + adapters + a service-equivalent router + a public `index.ts` barrel; **no `routes.ts`
yet** — no HTTP/WS transport is wired to the router this phase, it is a consumable seam).
- `ports.ts` — the transport-agnostic `LlmProvider` contract every adapter and the scriptable
  mock implement: `stream(req, signal)` yielding a discriminated `token`/`done` union (never a
  boolean flag), zod schemas for provider ids / chat requests / stream events, and the `Meter`
  port (+ `noopMeter`) every paid call reports through.
- `router.ts` (`createLlmRouter`) — the failover engine. It races the first non-empty token
  against `ttftTimeoutMs`, commits to the first provider that emits one and **never switches
  after** (invariant 4), guards each post-commit gap with `stallTimeoutMs`, and on a pre-commit
  failure/timeout falls over to the next configured provider. Success/usage is metered the
  instant the terminal `done` is observed — exactly-once, so a consumer that breaks right after
  `done` is still metered — and a caller `AbortSignal` promptly unwinds the active attempt.
  `provider-health.ts` is the per-router circuit breaker + auth-bench (bad-key providers benched
  far longer than a transient cooldown) that skips unhealthy providers without calling them.
- `errors.ts` — typed error taxonomy (`LlmError` kinds auth/transient/stall/aborted,
  `AllProvidersFailedError` carrying per-provider failure summaries with raw cause, HTTP-status
  classifier). `config.ts` — every knob defaulted and overridable (timeouts, breaker
  threshold/cooldown, auth cooldown, default failover order `anthropic→openai→google→groq`);
  reads no `process.env` (env wiring is the caller's job).
- `adapters/` — four REAL providers behind the port, the ONLY place vendor SDKs are imported
  (RULES: SDKs live in `modules/*/adapters/`): `anthropic.ts` (`@anthropic-ai/sdk`),
  `openai.ts` + `groq.ts` over a shared
  `openai-compatible.ts` engine (Groq reuses the `openai` SDK against Groq's base URL — no
  second dependency), `google.ts` (`@google/genai`); vendor errors → taxonomy via `map-error.ts`,
  vendor usage → the `done` event via `usage.ts`. `factory.ts` (`createProvidersFromEnv`) builds
  only the providers whose API key is present, in default order, so the server boots with any
  subset (or none).
- **Metering was a stub this phase — landed in Phase 6.** The `Meter` port exists and the
  router records at every success; since Phase 6 the production wiring threads a REAL
  per-call meter (`metering.meterFor`) through every consumer and the wired default
  `noopMeter` survives only as the router-internal fallback that the static audit proves
  unreachable in production wiring (see the Phase 6 block).
- **Env keys are optional.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` /
  `GROQ_API_KEY` were added to `env.ts` and `.env.example`, all `.optional()`; an absent key
  just means one fewer routable provider — the server still boots and serves `/health`.
- Proven by **27 router behavior tests** (`router.{race,commit,stall,breaker,classify,order,
  meter}.test.ts`) plus adapter/usage/error-mapping units — 94 llm tests green, fake-timer only,
  zero unhandled rejections. **Live smoke is deferred:** `adapters/live.smoke.test.ts` drives
  each real adapter through the router but self-skips without a vendor key (CI has none); the
  phase's ≥2-provider live-smoke gate awaits Gustavo's keys, so the default model ids above are
  unverified against the live vendors until then.

**Live-call STT gateway (Phase 3 — live on `dev-claude-stt`):** the phone-dumb / server-brain
live spine — design spec in `DESIGN/live-pipeline.md`.
- **Wire protocol** — `packages/shared/src/live.ts`: one versioned (`v: 1`) zod discriminated
  union per direction, snake_case on the wire. Up: `session.start`/`session.end`, `ping`, and an
  `audio.frame` MARKER only (real audio travels as raw binary WS frames, never JSON). Down:
  `transcript.partial`/`transcript.final`, `provider_switched`,
  `suggestion.start`/`delta`/`done`/`discard` (defined now, emitted in Phase 7), `error`, `pong`,
  plus a test-only `audio.echo`. `parseClientEvent` safe-parses every inbound message (RULES:
  parse every boundary, no throws across the seam).
- **`modules/live/`** — `routes.ts` is the ONLY file that touches `ws`: it registers
  `@fastify/websocket` (64 KB `maxPayload`), authenticates the `GET /live` upgrade
  (`Authorization` header primary, `?token=` query fallback for RN; failure → 4401/4503 policy
  close), buffers up to 64 frames during the JWKS-bound auth window (overflow → 1009 close), and
  adapts raw socket events onto a transport-agnostic `LiveSession` (`session.ts`) whose teardown
  runs exactly once via an idempotent disposer (a dropped phone aborts the vendor socket — the
  money-leak rule). The `?token=` value is stripped from request logs globally
  (`plugins/log-redaction.ts`) so it never lands in the logs.
- **`modules/stt/` engine** (`engine.ts`) — relays audio frames to a FIXED priority-ordered
  vendor lineup and hides vendor churn from the client. Semantics: a dropped/silent socket
  **reconnects the SAME vendor** invisibly (bounded drop-oldest frame buffer + backoff ladder);
  consecutive failures crossing `failoverThreshold` (pre-establishment) or `maxReconnects`
  (post-establishment) **fail over** to the next vendor with a single `provider_switched`; a
  vendor emitting nothing past `vendorSilenceTimeoutMs` while audio flows is treated as dead and
  reconnected; only when EVERY vendor is exhausted does the client see one typed `error` (never a
  hang). Sequential attempt-loop with a per-attempt `AbortController` + active abort on teardown
  (adr-0004 shape, mirroring the llm router). No disk, no network, no vendor SDKs in the engine
  itself; tunables are zod-parsed in `config.ts`.
- **Vendor adapters** (`modules/stt/adapters/`) — AssemblyAI (primary, `ASSEMBLYAI_API_KEY`) +
  Deepgram (fallback, `DEEPGRAM_API_KEY`) behind the `SttVendor` port (RULES §5: SDKs only in
  `adapters/`; SDK-internal retries OFF per adr-0004 §3). `vendors.ts` builds the lineup from env
  — a vendor is included only when its key is present, so the server boots with neither, one, or
  both. **Both keys are OPTIONAL** (`env.ts`): with none, a live session surfaces a typed `error`
  instead of transcribing — no crash. Company-held secrets; never in the repo, never shipped to
  mobile.
- **Fixtures + accuracy bars** — a reproducible two-speaker fixture pipeline
  (`scripts/make-stt-fixtures.sh`) writes `apps/server/fixtures/stt/two-speaker-60s{,-noisy}.wav`
  (+ a `.json` turn/reference manifest). The live word-overlap / diarization / dead-vendor
  failover accuracy bars (`modules/stt/adapters/live.accuracy.test.ts`) are **key-gated
  (`describe.skipIf`) and UNRUN** — they need real vendor keys, exactly like Phase 2's live smoke;
  everything else runs green against scriptable mock vendors. Raw audio is **never written to
  disk** — enforced by a static + runtime `[no-disk]` audit pair
  (`engine.no-disk.test.ts`, `no-disk.audit.test.ts`).

**Phase 4 — `modules/rag/` (per-user RAG memory, built on `dev-claude-rag`):**
- **Ports + pure chunker** (`ports.ts`, `chunker.ts`, `config.ts`) — four swappable seams
  (`Chunker` / `Embedder` / `VectorStore` / `Reranker`) plus the typed `RagError` taxonomy
  (`RAG_NOT_CONFIGURED` / `EMBEDDER_FAILED` / `STORE_FAILED` / `SOURCE_TOO_LARGE`). The chunker is
  pure and deterministic (zero I/O, zero clock): transcripts pack by diarized turn, docs by
  paragraph, each chunk carrying a contextual header for both embedding and full-text indexing.
- **Embeddings adapter** (`adapters/voyage.ts`, `VOYAGE_API_KEY`) — Voyage `voyage-4`/`voyage-4-lite`
  at 1024 dims behind the `Embedder` port (SDK-free HTTP; RULES §5). Stores under the
  **embedding-SPACE id** `voyage-4` (adr-0005 §2) so the query (fast) and document (batched) tiers
  share one search filter; the per-call vendor model appears only in usage logs. **Key-gated:** with
  no key the server still boots and ingest/live retrieval degrade explicitly (same posture as
  keyless STT).
- **Vector store** (`adapters/pgvector.ts`) — the ONLY RAG hot path to Postgres, over a direct `pg`
  Pool on `SUPABASE_DB_URL` (adr-0005 §4: PostgREST ~triples p95). `search` runs hybrid retrieval
  (semantic cosine + full-text) fused by **reciprocal-rank fusion in ONE round trip**; `replaceSource`
  is the idempotent soft-delete-then-insert upsert. Every leg carries an explicit `user_id`
  predicate (tenant isolation is the WHERE clause; RLS is defense-in-depth), and `hnsw.iterative_scan
  = relaxed_order` keeps filtered-ANN recall honest on a small per-user slice of a big global table.
- **Service + auto-indexer** (`service.ts`, `indexer.ts`, `db/rag-indexer.ts`) — `RagService`
  orchestrates chunk→embed→store for ingest and embed→search(+rerank) for retrieval. The
  marker-and-sweep indexer polls finished-but-unindexed meetings (`ended_at` set, `indexed_at`
  null), chunks + embeds + stores each transcript, and stamps `indexed_at` — idempotent, oldest
  completion first, bounded batch per tick.
- **Exit bars.** Freshness (`rag.freshness.integration.test.ts`) proves a finished call is queryable
  in **~0.7s vs the <60s** bar through the real sweeper + real store (deterministic mock embedder, no
  key). Store latency (`scripts/bench-rag.ts`, `npm run bench:rag`) seeds 10k chunks for one user +
  30k noise across 3 others and measures 100 hybrid `search` calls: **p50 5.2ms / p95 7.2ms / max
  9.6ms vs the <300ms** bar — no vendor key (seeded pseudo-random unit vectors). The **top-3 retrieval
  accuracy gate** (`rag.accuracy.test.ts`) and the **live Voyage smoke** (`voyage.live.smoke.test.ts`)
  are **key-gated (`describe.skipIf`) and UNRUN** — they need a real `VOYAGE_API_KEY` (Gustavo action
  item), exactly like Phase 2's llm smoke and Phase 3's STT accuracy bars were before their keys
  landed. A store-query-embed split is deliberate: this p95 bar governs the store only; query-embed
  latency is vendor-side and reported separately by the key-gated smoke. **Update (2026-07-22,
  post-key):** both key-gated gates RAN and PASSED — see the PARITY rows 24–25 note.

**Phase 5 — `modules/notes/` (post-call notes pipeline, built on `dev-claude-notes`):** the MVP
hero — design spec `DESIGN/notes-pipeline.md`, decisions `DECISIONS/adr-0006-notes-pipeline.md`.
- **Durable queue** (`db/jobs.ts`) — a hand-rolled `jobs` table store over the direct `pg` Pool
  (adr-0006 §1): atomic `FOR UPDATE SKIP LOCKED` claim (multi-instance-safe), jittered-backoff
  retry, lease + reaper crash recovery (`reapExpired`), dead-letter at the attempt cap, sweep
  backstop (`sweepEnqueue` — ended, live, un-noted meetings can never be lost), `hasActive` for
  the regenerate 409. Every product-visible transition mirrors the denormalized
  `meetings.notes_status`; `complete()` deliberately does NOT flip it — the 'completed' flip is
  atomic with the notes write in `db/notes.ts` so a completed job whose write failed never reads
  as ready (adr §2). Enqueue is belt-and-suspenders: EAGER on `markEnded` (wired in
  `modules/live/routes.ts` as an injected callback) + the sweep (adr §4).
- **Worker + handler** (`worker.ts`, `handler.ts`, `config.ts`) — poll loop (~5s) + reaper loop,
  exactly-once start/stop, one job per tick; the handler loads meta + final turns
  (`db/notes-source.ts`), runs the pipeline, persists via `db/notes.ts`, and maps outcomes:
  missing meeting → terminal fail, soft-deleted → complete no-op, transport failure → retry.
  All lease/backoff/interval numbers are zod-config and injectable. Gated behind
  `NOTES_WORKER_ENABLED=true` + DB + ≥1 LLM key, never under test.
- **Pipeline** (`pipeline.ts`, `chunking.ts`, `map-reduce.ts`, `ladder.ts`, `verify-quotes.ts`,
  `prompts/`) — classify (small call, failure → 'casual') → generate: single-pass under
  `maxSinglePassTokens` (32k default), MAP-REDUCE above it (turn-boundary ~6k chunks, ~15%
  overlap, structured facts + mini-summaries, reduce merges in code — early-call facts cannot
  be re-derived away). Every structured response walks the ladder: salvage (`jsonrepair`) → zod
  → ONE repair round-trip → deterministic schema-valid fallback (`source:'fallback'`); raw
  failing text lands on `jobs.raw_output`, never in `meetings.notes` (RULES §1 — malformed LLM
  JSON is unrepresentable in the typed column). Quotes are substring-verified against the
  transcript; failures are FLAGGED `unverified`, never dropped. Deadlines resolve against an
  injected calendar table (weekday→ISO lookup, not model date arithmetic — a live-gate fix).
  The pipeline consumes the EXISTING `LlmRouter` (its first wired consumer); it never touches
  vendor SDKs.
- **Follow-up + REST** (`follow-up.ts`, `routes.ts`, `db/notes.ts`) — the follow-up generator's
  input type is the VALIDATED notes object + tone + title: it cannot receive a transcript, so
  cites-notes-only holds by construction and is asserted mechanically on the captured prompt
  (adr §8). Authed surface (all `requireAuth`, user-scoped, uniform 404 for
  missing/foreign/soft-deleted — no existence leak): `GET /meetings/:id/notes`,
  `POST /meetings/:id/notes/regenerate` (202 | 409 `already_running`),
  `POST /meetings/:id/follow-up` (200 persisted draft | 409 `notes_not_ready` | 503
  `provider_unavailable` on transport failure — synchronous, one small call). Wire schemas in
  `packages/shared/src/notes.ts` (versioned `meetingNotesSchema`, follow-up + response shapes).
- **Stale-call reaper** (`db/stale-call-reaper.ts`) — stamps `ended_at` on crashed-mid-call
  orphans (~6h, config), feeding BOTH the RAG indexer and the notes queue — closes the Phase 4
  crash-orphan opener.
- **Cost visibility** — per-attempt token usage persists on `jobs.usage` (jsonb) and every
  completion emits one per-user structured log line `{user_id, meeting_id, job_id,
  input_tokens, output_tokens, calls}`; the follow-up endpoint logs its own — the Phase 6
  metering seam (ids/counts only, never content).
- **Exit bars.** Mock/DB: the ladder walk, quote-grounding flags, map-reduce boundary-fact
  survival, kill-worker recovery + concurrent-claim single-winner (`db/jobs.integration.test.ts`,
  tiny-lease reaper), the full loop (`notes.pipeline.integration.test.ts`: markEnded → eager
  enqueue → worker tick → zod-valid notes + usage jsonb on the job row), and the route contract
  (`routes.integration.test.ts`: real JWTs, 401/404-trio/409s/400/503, follow-up persisted).
  **Live (key-gated, RAN GREEN 2026-07-22 after one prompt-iteration round):**
  `notes.accuracy.test.ts` — sales/interview/casual fixture fact-checks (owner "Marcus" +
  deadline 2026-07-24 from "by Friday", zero unverified quotes), three DISTINCT
  conversation-type shapes, and the long-call map-reduce bar (first- AND last-10-min planted
  facts survive a forced map-reduce over the ~90-min fixture).

**Phase 6 — `modules/metering/` (usage metering, quotas, billing hooks, built on
`dev-claude-metering`):** design spec `DESIGN/metering.md`, decisions
`DECISIONS/adr-0007-metering.md` (+ its Phase 6 build amendments). GATES external
TestFlight — the kill-switch E2E is green.
- **Ledger** (`db/usage-events.ts`, migration `20260722130000`) — append-only
  `usage_events` (NO `deleted_at`: adr-0007 §1's explicit RULES §3 exception; the purge
  worker deletes its rows first), one row per metered vendor call
  (`llm_tokens | stt_seconds | embedding_tokens | rerank_requests`), amounts as facts +
  `cost_estimate_usd` stamped at write time from the zod price book (`pricing.ts`;
  unknown model/vendor → $0 + one warn, never blocks; anthropic stays priced though
  disabled). Users read their own bar tab (`usage_events_select_own`); writes are
  service-role-only. Sums are SQL aggregates over a direct `pg` Pool.
- **Service + per-call meters** (`service.ts`, `ports.ts`) — `record()` prices + inserts
  and NEVER throws (error-log + continue: a metering failure never fails the metered op —
  safe because the static audit guarantees the sink is real); `meterFor(userId,
  meetingId?)` builds the llm `Meter` closure; `usedInPeriod` (rolling 30d) and
  `spendTodayUsd` (UTC day) feed enforcement. The llm surface gained
  `stream(req, {meter})` — a per-call override so attribution travels WITH the call while
  breaker/bench state stays process-global (adr-0007 §2); the notes pipeline + follow-up
  thread it via a `meterFor` factory, the Voyage `logUsage` sink maps embedding/rerank
  lines onto the ledger (rerank bills amount=1/request), and the live session bills
  relayed-audio bytes (16kHz PCM16 → bytes/32000 = seconds) with spans flushed on vendor
  switch / disposal / each quota tick (`modules/live/stt-usage.ts`; a crash loses ≤ one
  tick; pre-first-failover attribution = the configured lineup head).
- **Enforcement** — plan quotas on AMOUNTS (`quota.ts` + `db/plans.ts`:
  `profiles.plan` free|pro → config limits; `>=` binds): live session start + mid-stream
  recheck every 15s of METERED audio → typed `quota_exceeded` + policy close; notes
  claim-time → dead-letter with `quota_exceeded` (never silent fallback notes — the
  paywall stays visible); follow-up → 429. **Gate ORDER in `session.start`
  (cheap/global → per-user):** concurrency (sync registry, slot released exactly-once via
  the disposer) → daily cap → meeting ownership → stt quota — ownership fails CLOSED,
  quota/cap fail OPEN (ratified posture; see the adr-0007 amendments). REST rate limiting
  (`plugins/rate-limit.ts`, @fastify/rate-limit, 100/min default, key =
  sha256(bearer) | IP pre-auth, typed 429; `/live` excluded — it has the
  one-session-per-user cap instead). Kill-switch (`kill-switch.ts`):
  `spendTodayUsd() >= $50` refuses NEW sessions (`daily_cap_reached`) and gates the
  worker's CLAIM itself (jobs stay queued, attempts unburned, in-flight finishes);
  exactly ONE `metering.daily_cap_tripped` error log per UTC day. **Honest posture:** the
  rate-limit store and session registry are in-memory single-instance (the deployment
  law; multi-instance = the logged opener family).
- **llm `invalid` class** — 400/404/422 now classify `invalid` (was `transient`):
  immediate failover, no same-provider retry, DOES count toward the breaker — the
  2026-07-22 anthropic credit-400 outage (which burned a failover sweep per call) is the
  live evidence. Auth 401/403 bench semantics unchanged.
- **RevenueCat webhook** (`revenuecat.ts`) — `POST /webhooks/revenuecat`, registered ONLY
  when `REVENUECAT_WEBHOOK_TOKEN` (+ the DB) is set; constant-time bearer check;
  defensively zod-parsed envelope; INITIAL_PURCHASE/RENEWAL/UNCANCELLATION → the mapped
  product's plan, EXPIRATION → free (CANCELLATION alone is a known no-op — access runs to
  period end); unknown types/products/anonymous ids → 200 `{applied:false}` + warn, never
  a 500. Idempotent absolute SET on `profiles.plan` via `db/plans.ts`. Fixture-proven;
  live RevenueCat account/products/SDK `app_user_id` are Phase 8+ (Gustavo).
- **Exit bars.** STT accuracy: the 58.4s fixture WAV relayed frame-by-frame bills within
  ±5% of ground truth (exact on relayed bytes) with failover splitting attribution
  (`session.metering.test.ts`). LLM accuracy: EXACT vendor-reported passthrough — known
  mock usage lands as exact `usage_events` rows + `usedInPeriod` sum
  (`metering.e2e.integration.test.ts`). Kill-switch: seeded ledger past $50 → new claims
  refused (queued survives, attempts 0), in-flight finishes, exactly one alert. Quota:
  tiny-quota session refused at start BEFORE any vendor connect; mid-stream cut typed +
  wire-valid. Wiring: the static audit (`metering.audit.test.ts`) — no vendor path
  without a real sink. RLS posture: `usage-events-rls.integration.test.ts` (A sees own
  rows only, authenticated INSERT denied, service-role full).

**Phase 7 — the live copilot loop (built on `dev-claude-live-copilot`):** design spec
`DESIGN/live-pipeline.md`, decisions `DECISIONS/adr-0004-llm-routing-latency.md`. Streaming
suggestions during a live call — first tokens on the wire immediately, rendered as ONE fixed
pane (not cards).
- **llm live tier** (`modules/llm/config.ts`, `ports.ts`, `router.ts`) — `chatRequest.latencyTier`
  `"live"|"deliberate"`; live selects the cheapest-first `liveOrder`
  (google→groq→openai→anthropic) unless `providerOrder` overrides. `liveLlmConfig()` bundles the
  tight TTFT (1500ms) / stall (8000ms) budgets. Reasoning stays OFF at the ADAPTER layer (flash
  `thinkingBudget:0`; mini/8b have none), so no per-call reasoning toggle. Additive — the 27
  pinned router tests are untouched; `router.tier.test.ts` covers order selection.
- **`modules/prompt`** — one PURE `assemble(mode, context) → { stablePrefix, dynamicSuffix }`.
  `content/system-prompt.ts` is Gustavo's authored co-pilot prompt extracted VERBATIM
  (byte-for-byte) from `docs/prompts/nova-prompts-source.md` by `scripts/gen-live-prompt.mjs`
  (code assembles, never writes prose — RULES §9). The `stablePrefix` is byte-stable (sha256
  pinned by `assemble.snapshot.test.ts` — the vendor prompt cache can't silently churn, adr-0004
  §6); the `dynamicSuffix` is the only uncached part: hard-guarded user context (delimited DATA
  after the prefix that owns identity/security) + RAG snippets under a hard token budget +
  windowed transcript LAST (the current moment ends the prompt). Budgets SHRINK the suffix, never
  delay first token. (The mobile screen/screenshot-block exclusion in the source-doc note is a
  token optimization DEFERRED — the full prose is kept verbatim rather than edit Gustavo's text.)
- **`modules/live` conductor** (`conductor.ts`, `conductor-config.ts`, pure `trigger.ts` +
  `speculation.ts`) — transport-agnostic. Maintains a rolling transcript window; the tiered
  trigger gate (triviality → small-talk veto → question → term → advancement) runs OFF the LLM hot
  path and stays QUIET in no-op windows. Speculates on confident partials, then jaccard-reconciles
  against the final (adopt the finished/in-flight answer, or emit `suggestion.discard` + refire —
  never a zombie card). Streams `suggestion.start/delta/done` coalesced ~50ms/batch, ONE focal
  pane (a new trigger supersedes the old). Deadline ladder actively aborts through the router if no
  first token in time; RAG grounding is raced against `ragDeadlineMs` and dropped if slow (shrink,
  never delay). Every suggestion call threads `metering.meterFor(userId, meetingId)`.
- **Wiring** — `metering-wiring.ts::maybeCreateLiveConductorFactory` builds ONE shared live-tuned
  router + RAG service (its Voyage usage lands on the ledger via the same sink as
  notes/indexer) and threads the per-call meter; `LiveSession` takes a `createConductor` factory,
  builds the conductor at `session.start` (after the quota/ownership gates, before STT, never in
  echo), feeds it the SAME transcript stream the relay forwards, and disposes it on teardown;
  `modules/live/routes.ts` consumes the factory. The static metering audit
  (`metering.audit.test.ts`) gained a case proving the live-router site threads `meterFor` — no
  unmetered live LLM path. Undefined on a keyless boot (transcription still runs, no suggestions).
- **Mobile** (`apps/mobile`) — `hooks/use-live-session.ts` OWNS the socket (screens dumb): maps
  wire events onto a FIXED streaming pane + a SEPARATE scrolling transcript; deltas append via a
  ref buffer flushed once per animation frame; `suggestion.start` replaces in place,
  `suggestion.discard` clears instantly. `features/live-call/` (CopilotPane, TranscriptList, a
  mic-less replay fixture) + the `(app)/live` screen + a Live tab. Real mic capture + UI polish
  are Phase 8/9.
- **Exit bars.** LATENCY (`conductor.latency.test.ts`, fake timers + REAL router + mock-LLM
  realistic TTFT): question-moment → first token **p50=800ms / p95=1450ms** (bars <2000 /
  <4000), final→visible **p50=800ms** (<1500), speculation-hit→visible **p50=0ms** (<500). QUIET +
  TRIGGER (`trigger.test.ts`, `conductor.test.ts`): 11 small-talk fixtures silent, 8 labeled
  moments fire the right kind, zero suggestion events on small-talk finals. RELEVANCE + GROUNDING
  are key-gated (RAN 2026-07-22): `live.relevance.test.ts` **9/10** (bar ≥7, OpenAI+Google);
  `live.grounding.test.ts` — the suggestion contained the ingested **$47,500** Acme fact
  (Voyage+pgvector+DB). Behavior (coalesce/supersede/deadline/meter/dispose) + the session
  conductor-wiring seam are unit-tested.

## Data model

The auth-domain tables (`profiles`, `meetings`, `transcripts`, `context_docs`,
`deletion_requests`) are **built** as of Phase 1, the RAG tables (`chunks`, `embeddings`)
plus the Phase 4 column expansions are **built** as of Phase 4, the `jobs` table plus the
meetings notes columns are **built** as of Phase 5, and the `usage_events` ledger plus
`profiles.plan` are **built** as of Phase 6 — see "Built so far" for their live shape
and RLS posture.

- `profiles` — user profile (1:1 with auth.users); **built (Phase 6):** **`plan`**
  (`text not null default 'free' check in ('free','pro')` — the quota tier, written by
  the RevenueCat webhook, read by the quota checker)
- `meetings` — id, user_id, title, started_at, **`ended_at`** (call completion), **`indexed_at`**
  (RAG sweeper marker: finished + null → unindexed backlog), deleted_at; **built (Phase 5):**
  **`notes`** jsonb (ONLY ever a zod-valid `meetingNotesSchema` object — the ladder guarantees
  it), **`notes_status`** (`none|queued|processing|completed|failed` — the denormalized read
  model, no jobs join), **`notes_generated_at`**, **`follow_up`** jsonb (latest draft
  `{tone, subject, body, generated_at}`)
- `jobs` — **built (Phase 5):** the durable background-job queue (`kind='generate_notes'`),
  service-role/pool-only — RLS enabled with **zero policies** (the `deletion_requests`
  posture). status `queued|processing|completed|dead`, attempts/max_attempts, `run_at`
  (backoff), `locked_at`/`locked_by` (lease), `last_error`, `raw_output` (failed generations
  keep raw model text HERE, never in a typed jsonb column), `usage` jsonb (per-attempt tokens —
  the Phase 6 metering seam); partial unique `(kind, meeting_id) where status in
  ('queued','processing')` — one active job per meeting, completed/dead rows are history
- `transcripts` — meeting_id, user_id, content, **`speaker`** (diarized label, nullable),
  **`ts_ms`** (turn time, nullable), created_at, deleted_at
- `context_docs` — user_id, title, content — a RAG source (the "your life" library)
- `chunks` — **built (Phase 4):** one retrievable text unit parented to EXACTLY ONE source
  (context_doc XOR meeting, CHECK-enforced), `content` + `header`, a STORED `fts` tsvector
  (lexical leg), soft delete
- `embeddings` — **built (Phase 4):** a chunk's vector under a named embedding-space `model`,
  `dims`, `embedding halfvec(1024)`, unique `(chunk_id, model)`; **HNSW** index (cosine) for ANN;
  denormalized `user_id` so the RLS/where predicate stays a flat owner check
- `usage_events` — **built (Phase 6):** the append-only usage/billing ledger — user_id,
  meeting_id (nullable), vendor, `kind` (`llm_tokens|stt_seconds|embedding_tokens|
  rerank_requests`, CHECK-enforced), `amount` numeric (tokens/seconds/requests — facts,
  quotas run on these), `input_amount`/`output_amount` (llm split), `model`,
  `cost_estimate_usd` (advisory, priced at write; the kill-switch runs on its sum),
  created_at. **NO `deleted_at`** — adr-0007 §1's explicit RULES §3 exception (a billing
  ledger is history, not user-managed data; the purge worker hard-deletes its rows FIRST).
  RLS: `usage_events_select_own` for authenticated, ZERO write policies (service-role
  writes only). Indexes `(user_id, created_at)` + `(created_at)` for the two sums.
- All user tables: RLS ON at creation, `deleted_at` soft delete (RULES §3, §4.9 —
  `usage_events` is the one documented exception above)

## Environments

| Env | Branch | Supabase project | Mobile channel | Guard |
|---|---|---|---|---|
| development | `development` (default) | nova-dev | Expo dev build | CI green |
| staging | `staging` | nova-staging | TestFlight internal | CI + promotion PR |
| production | `main` | nova-prod | App Store / TestFlight ext | CI + manual approval |

Feature branches: `dev-<who>-<topic>`, always off `development`, always PR back into
`development`, merge commits only, branches kept after merge (GIT_WORKFLOW.md).

Details in `GIT_WORKFLOW.md`.

## Decisions log

- **ADR-0001** — Stack: TypeScript/Node + Supabase + React Native/Expo (see DECISIONS/)
- **ADR-0002** *(implicit, to formalize)* — STT: AssemblyAI primary + Deepgram Nova-3
  fallback; acoustic (mic/speakerphone) capture model
- **ADR-0003** *(implicit, to formalize)* — Clean build from public patterns; no code
  from the personal-use-licensed reference repo (RULES §9)
- **ADR-0004** — LLM routing, latency tiers, and prompt-cache strategy (see DECISIONS/); the
  Phase 3 STT engine reuses its sequential-cascade + SDK-retries-off shape. Companion live-pipeline
  build spec: `DESIGN/live-pipeline.md`.
- **ADR-0005** — RAG memory: Voyage `voyage-4`/`voyage-4-lite` @1024 halfvec, model column is the
  embedding-SPACE id (two-speed query/document tiers share one search filter), HNSW +
  `iterative_scan`, hybrid RRF in one round trip over a direct `pg` Pool (not PostgREST),
  rerank deliberate-tier-only, marker-and-sweep auto-indexer (`ended_at`/`indexed_at`),
  turn-window chunking with metadata headers. Design: `DESIGN/rag-memory.md`.
- **ADR-0006** — Post-call notes pipeline: hand-rolled `jobs` table over `FOR UPDATE SKIP
  LOCKED` (not pg-boss/graphile), jobs-for-execution + `meetings.notes_status` read model,
  at-least-once + idempotent worker with lease/reaper recovery, eager + sweep enqueue,
  single-pass primary with a 32k-token map-reduce gate, quote-grounding (flag-don't-drop),
  the portable structured-output ladder (salvage → zod → one repair → constant fallback),
  follow-up drafts citing notes by construction. Design: `DESIGN/notes-pipeline.md`.
- **ADR-0007** — Metering, quotas, and the spend kill-switch: one append-only
  `usage_events` ledger config-priced at write time (amounts are facts, dollars are
  advisory); per-call meter injection (`stream(req, {meter})`) over per-user routers;
  STT billed by relayed frames; plan quotas on amounts at start AND mid-stream; the
  refuse-new/finish-in-flight daily kill-switch on estimated dollars;
  @fastify/rate-limit + an in-memory one-session-per-user registry; RevenueCat as a
  fixture-tested seam. Build amendments (in the ADR): quota/cap FAIL-OPEN vs ownership
  FAIL-CLOSED, lineup-head STT attribution, rerank amount=1/request, RC static-bearer
  auth. Design: `DESIGN/metering.md`.
