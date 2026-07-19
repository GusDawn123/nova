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

**Status: Phase 1 auth complete on `dev-claude-auth` (pending PR/merge into `development`;
Phase 0 PR #1 already merged).** On top of the Phase 0 scaffold, Phase 1 added the auth
domain: four tables + RLS (`profiles/meetings/transcripts/context_docs`) plus the
`deletion_requests` purge queue; a server auth layer (ES256/JWKS token verify, `requireAuth`
preHandler, protected `GET /me` and `DELETE /account`); mobile email auth with session
persistence (single `lib/supabase` seam, `(auth)`/`(app)` route groups); and RLS A/B
isolation tests that run against real Postgres in CI. Apple/Google sign-in is deferred (needs
Gustavo's dev accounts). Supabase remains **local-only** — the cloud project is deferred to
Gustavo; iOS-simulator verification is still deferred (Expo web + Playwright instead). Phases
2+ of `docs/LOOP_PLAYBOOK.md` build the rest of the product on top.

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
- No unmetered paths to paid vendor APIs (everything flows through `modules/metering`).
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

# Mobile workspace (apps/mobile, Expo)
npm run start --workspace apps/mobile   # expo start (add --web / --ios / --android)
```

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test on every PR, then a
Supabase **shadow migration replay** (`supabase db start`) that self-activates now that
`supabase/config.toml` exists. `npm run check` is the local mirror of the first three.

## Conventions

- Branches: `dev-<who>-<topic>` (e.g. `dev-claude-rls-policies`); scripts verb-first
  (`backfill_*`). Style rules: docs/RULES.md §10 (Prettier + typescript-eslint
  strict-type-checked; discriminated unions over boolean flags; async/await only;
  screens dumb / hooks smart; tokens-only styling; snake_case SQL)
- Module anatomy: `ports.ts / adapters/ / service.ts / routes.ts / schemas.ts / __tests__/`
- Soft cap ~400 lines/file — split before you blow past it
- Structured errors + logs with `request_id`/`user_id`; never log secrets or raw
  transcripts at info level
