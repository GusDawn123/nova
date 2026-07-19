# Nova — Architecture

> **Living document.** Updated in the same PR as any change to structure, data model,
> or data flow (RULES.md §8). Describes the present; the "why" lives in `DECISIONS/`.
>
> **Status: pre-scaffold (design finalized, Phase 0 not yet run).**

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

## Data model (v0 sketch — becomes real in Phase 1)

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
