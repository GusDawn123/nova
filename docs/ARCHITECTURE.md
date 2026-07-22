# Nova — Architecture

> **Living document.** Updated in the same PR as any change to structure, data model,
> or data flow (RULES.md §8). Describes the present; the "why" lives in `DECISIONS/`.
>
> **Status: Phase 4 RAG memory built on `dev-claude-rag` (branched off `development`, which now
> carries Phases 0-3). Phases 0-3 are merged into `development`: Phase 0 scaffold (PR #1), Phase 1
> auth (PR #2), Phase 2 `modules/llm` (PR #3), Phase 3 streaming STT gateway (PR #4). Phase 4 adds
> `modules/rag`: the pure chunker, the four ports (Chunker/Embedder/VectorStore/Reranker), the
> Voyage + pgvector adapters, `RagService`, and the marker-and-sweep auto-indexer over the
> `chunks`/`embeddings` (halfvec 1024, HNSW) tables. What runs GREEN: the mock/DB suites, the RLS
> isolation tests, the freshness exit bar (auto-index queryable in ~0.7s vs the <60s bar), and the
> store-level latency bar (p95 7.2ms over a 40k-chunk corpus vs the <300ms bar). What is KEY-GATED
> and SKIPPED pending `VOYAGE_API_KEY`: the live Voyage smoke and the top-3 retrieval accuracy
> gate.** On the live-call spine below, this tree also carries the shared WebSocket wire protocol,
> the authenticated `GET /live` socket + per-call session, the `modules/stt` gateway (engine +
> AssemblyAI/Deepgram adapters, live accuracy bars GREEN), and the `llm` failover router + four
> real provider adapters (no transport wired to them yet). The notes/metering modules remain
> design-only — see "Built so far" for what exists and `DESIGN/live-pipeline.md` for the
> live-pipeline spec.

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
│           │   ├── sessions/  # live-call session lifecycle (WS)
│           │   ├── stt/       # ports.ts, adapters/{assemblyai,deepgram}, gateway
│           │   ├── llm/       # ports.ts, adapters/{anthropic,openai,google,groq},
│           │   │              #   router (fallback race, breaker), prompts/
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

### Built so far (Phase 0 scaffold + Phase 1 auth + Phase 2 LLM router + Phase 3 STT gateway + Phase 4 RAG memory)

The tree above is the target. What exists today is the skeleton, the `/health` vertical
slice, the **Phase 1 auth domain**, the **Phase 2 LLM provider router**, and the **Phase 3
live-call STT gateway** — all below. The remaining product modules (rag/notes/metering) and
the mobile `features/` are not built yet. Phase 2's `modules/llm` is now in this branch's tree
(merged into `development` via PR #3, then merged here); its section and the Phase 3 STT section
both follow.

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
  `NO ACTION`) is: **embeddings → chunks → transcripts → meetings → context_docs →
  deletion_requests → auth.users** — the Phase 4 RAG tables (`chunks` → meetings /
  context_docs / profiles; `embeddings` → chunks / profiles) must be purged BEFORE the
  meetings/context_docs they hang off. NOTE: the `deletion_requests` migration header
  predates the RAG tables and still lists the shorter `transcripts → meetings →
  context_docs → deletion_requests → auth.users` order; an applied migration is law and
  is not edited (RULES §4) — this doc carries the current contract.
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
- **Metering is a stub this phase.** The `Meter` port exists and the router records at every
  success, but the wired default is `noopMeter`; the real `metering` module lands in a later
  phase (invariant 2 preserved by construction — there is no unmetered code path, only a no-op
  sink today).
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
  latency is vendor-side and reported separately by the key-gated smoke.

## Data model

The auth-domain tables (`profiles`, `meetings`, `transcripts`, `context_docs`,
`deletion_requests`) are **built** as of Phase 1, and the RAG tables (`chunks`, `embeddings`)
plus the Phase 4 column expansions are **built** as of Phase 4 — see "Built so far" for their
live shape and RLS posture. The `usage_events` sketch below becomes real in Phase 6.

- `profiles` — user profile + plan (1:1 with auth.users)
- `meetings` — id, user_id, title, started_at, **`ended_at`** (call completion), **`indexed_at`**
  (RAG sweeper marker: finished + null → unindexed backlog), notes jsonb, deleted_at
- `transcripts` — meeting_id, user_id, content, **`speaker`** (diarized label, nullable),
  **`ts_ms`** (turn time, nullable), created_at, deleted_at
- `context_docs` — user_id, title, content — a RAG source (the "your life" library)
- `chunks` — **built (Phase 4):** one retrievable text unit parented to EXACTLY ONE source
  (context_doc XOR meeting, CHECK-enforced), `content` + `header`, a STORED `fts` tsvector
  (lexical leg), soft delete
- `embeddings` — **built (Phase 4):** a chunk's vector under a named embedding-space `model`,
  `dims`, `embedding halfvec(1024)`, unique `(chunk_id, model)`; **HNSW** index (cosine) for ANN;
  denormalized `user_id` so the RLS/where predicate stays a flat owner check
- `usage_events` *(Phase 6)* — user_id, vendor, kind (stt_seconds|llm_tokens), amount, cost_estimate
- All user tables: RLS ON at creation, `deleted_at` soft delete (RULES §3, §4.9)

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
