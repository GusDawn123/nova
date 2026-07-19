# Nova — Architecture

> **Living document.** Updated in the same PR as any change to structure, data model,
> or data flow (RULES.md §8). Describes the present; the "why" lives in `DECISIONS/`.
>
> **Status: Phase 1 auth built on `dev-claude-auth` (pending PR/merge; Phase 0 merged).**
> On top of the scaffold, the auth domain now exists: the four auth-domain tables + RLS,
> the `deletion_requests` purge queue, a server JWT-verify + `/me` + `/account` layer, and
> mobile email auth. The module/data-model shapes below are the finalized *design*; the STT/
> LLM/RAG/notes/metering modules are still design-only — see "Built so far" for what exists.

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
├── ports.ts        # interfaces the module needs from the outside world
├── adapters/       # vendor implementations of ports (ONLY place SDKs are imported)
├── service.ts      # business logic, exported interface for other modules
├── routes.ts       # HTTP/WS surface, zod-parsed in and out
├── schemas.ts      # module-local zod (shared ones live in packages/shared)
└── __tests__/      # behavior tests, fixtures in __tests__/fixtures/
```

### Built so far (Phase 0 scaffold + Phase 1 auth)

The tree above is the target. What exists today is the skeleton, the `/health` vertical
slice, and the **Phase 1 auth domain** below. The `modules/*` product modules (stt/llm/
rag/notes/metering/sessions) and the mobile `features/` are not built yet.

Two structural deviations from the drawing, both intentional:

- **Mobile lives under `apps/mobile/src/`** (`src/app/`, `src/components/`,
  `src/hooks/`, `src/lib/`, `src/constants/`) — Expo's `src/`-rooted template — not at the
  workspace root as drawn. The `features/` and `theme/tokens.ts` folders arrive with the
  product screens; `src/constants/theme.ts` is the current token home.
- **Server is `apps/server/src/{app.ts, env.ts, index.ts, auth/, db/, plugins/}`** — flat
  slices, not the `modules/<name>/` anatomy yet. `db/` wraps supabase-js behind a port with
  an optional-env client. The auth surface is `auth/verify-token.ts` (token boundary) +
  `plugins/auth.ts` (the `requireAuth` preHandler), matching the request-id-plugin posture;
  a formal `modules/auth/` lands when the product modules do.

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
  tombstone; the migration header carries the purge-worker FK-ordering contract
  (transcripts → meetings → context_docs → deletion_requests → auth.users).

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

## Data model

The auth-domain tables (`profiles`, `meetings`, `transcripts`, `context_docs`,
`deletion_requests`) are **built** as of Phase 1 — see "Built so far" for their live shape
and RLS posture. The rest below is the v0 sketch that becomes real in later phases.

- `profiles` — user profile + plan (1:1 with auth.users)
- `meetings` — id, user_id, title, started_at, duration, status
  (queued|processing|completed|failed), notes jsonb, deleted_at
- `transcripts` — meeting_id, speaker, text, ts_ms, is_final
- `context_docs` / `chunks` / `embeddings(vector)` — the RAG memory, embedding-model
  versioned
- `usage_events` — user_id, vendor, kind (stt_seconds|llm_tokens), amount, cost_estimate
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
