# Nova Engineering Rules (the Constitution)

These rules bind every contributor — human or AI, every session, every loop.
A PR that violates a rule doesn't merge. If a rule must bend, that's an ADR
(`docs/DECISIONS/`), not a silent exception.

---

## 1. Type safety — parse, don't trust

- **TypeScript `strict: true` everywhere.** Plus `noUncheckedIndexedAccess`. No new `any`;
  `as`-casts need a `// why:` comment or they don't pass review.
- **Every boundary gets a zod schema** in `packages/shared/schemas/`: API requests AND
  responses, WebSocket events, LLM structured outputs, vendor webhook payloads, env vars.
  Data from outside the process is `unknown` until parsed. No exceptions — a "trusted"
  vendor payload is still parsed.
- **Env config validated at boot** — the server refuses to start with missing/malformed
  config rather than failing at 3am mid-request.
- **DB row types are generated** (`supabase gen types typescript`), never hand-written.
  Regenerate in the same PR as any migration.
- **LLM outputs are hostile input.** Structured LLM output goes through: zod parse →
  one repair round-trip → deterministic fallback. Malformed JSON must be unrepresentable
  in the DB.

## 2. Reusability & module boundaries

- **Ports & adapters for every vendor.** Vendor SDKs (`openai`, `@anthropic-ai/sdk`,
  AssemblyAI, Deepgram, RevenueCat…) may ONLY be imported inside that module's
  `adapters/` directory, behind an interface defined in `ports.ts`. Swapping a vendor
  must never touch business logic. This includes RAG (rule 5).
- **Server modules are islands.** `modules/llm` may not reach into `modules/notes`
  internals — cross-module calls go through the module's exported service interface only.
- **Mobile: tokens → primitives → features → screens.** All colors/spacing/type come from
  `theme/tokens.ts` (no inline hex, no magic numbers). `components/ui/` primitives are
  app-agnostic; `features/` compose primitives; screens compose features.
- **No god objects.** Soft cap ~400 lines per file; at 400, split by responsibility.
  (The reference apps in this space have 7k-line files nobody can safely edit. Never here.)

## 3. Data: soft delete, always

- **Never hard `DELETE` from application code.** Every user-data table has
  `deleted_at timestamptz NULL`. "Delete" = set `deleted_at = now()`.
- RLS policies and standard queries exclude `deleted_at IS NOT NULL` rows by default.
- **Compliance purge is the one exception:** a dedicated, scheduled purge job
  hard-deletes rows whose `deleted_at` is older than the retention window, and the
  account-deletion flow (Apple requirement) queues a full purge. Purge code lives in ONE
  place (`scripts/purge/`), is idempotent, and logs what it removed.
- **Transcript-only storage:** raw audio is never persisted server-side. Transcripts,
  notes, and embeddings are stored; audio buffers die with the session.

## 4. Migrations (adapted from the battle-tested Django house style)

Supabase CLI migrations: timestamped SQL files in `supabase/migrations/`. Local dev and
CI run **real Postgres** (`supabase start` / shadow DB) — dev/prod parity is total; a
migration passing locally IS evidence (unlike the old SQLite-vs-Postgres world).

1. **Expand → backfill → contract. Never in one step.** Three separate migrations/PRs so
   there is always a moment where old and new code both work:
   - *Expand* — add column/table nullable, add new index `CONCURRENTLY`; old code unaffected
   - *Backfill* — a separate script (see 4.3), never inline DML in the schema migration
   - *Contract* — only after the expand+backfill are deployed and verified: drop old
     column / `SET NOT NULL`. Contract migrations wait at least one full deploy cycle.
2. **Every migration documents its reverse.** Header comment: either the literal down-SQL,
   or `-- IRREVERSIBLE: <why>` stated explicitly so the choice is visible in review.
   Destructive statements (DROP, DELETE) may only appear in contract-step migrations.
3. **Backfill house style** (`scripts/backfills/`):
   - Batched (`ORDER BY id LIMIT n` loops) — these run against prod tables
   - **Idempotent guards** (`WHERE new_col IS NULL`) so a re-run is always safe
   - Header docstring: *why*, plus a `Notes for reviewers:` section
   - Reads/writes through plain SQL against the historical schema — never import app
     model code (the app's current types describe the FUTURE schema, not the one mid-flight)
4. **Never edit or delete an applied migration. Never squash. Never fake.** To retire one,
   neuter it into a no-op checkpoint so the chain stays intact, runbook in the header.
5. **Seed data does NOT go in migrations.** Local fixtures → `supabase/seed.sql`;
   anything operational → verb-first scripts (`scripts/seed_plans.ts`).
6. **Verb-first naming** for anything hand-written: `backfill_`, `seed_`, `populate_`,
   `enforce_`, `migrate_`, `rename_`, `drop_`, `cleanup_`.
7. **Ordering is explicit.** Timestamped filenames give total order; if a migration
   depends on a non-obvious prior state, say so in the header comment.
8. **CI gate on every PR:** apply ALL migrations to a fresh shadow DB + `supabase db diff`
   drift check (committed schema must exactly match migration replay). Red = no merge.
9. **RLS is part of the migration.** A table's RLS policies ship in the SAME migration
   that creates the table — no window where a table exists unprotected. RLS changes
   require an isolation test (user A cannot see user B) in the same PR.

## 5. RAG stays decoupled

The RAG subsystem is four swappable ports: `Chunker`, `Embedder`, `VectorStore`,
`Reranker`. pgvector is *an adapter*, not the architecture. No route/feature imports
RAG internals — only `RagService.query(userId, text, opts)` / `.ingest(...)`.
Embedding-model name + dimensions are versioned columns so a model swap can re-embed
incrementally instead of big-banging.

## 6. Errors, logging, money

- **Typed errors** (`QUOTA_EXCEEDED`, `PROVIDER_DOWN`, `SCOPE_DENIED`…) — never throw
  raw strings; never `catch {}` silently (minimum: structured log with context).
- **Structured logs** (JSON) with `request_id` + `user_id` on every server log line.
  Never log: API keys, tokens, raw transcripts at info level.
- **Every metered vendor call records usage** (user id, vendor, tokens/seconds, cost
  estimate) — this is billing-grade data, treated with test coverage to match.
- **Spend kill-switches are sacred:** per-user quotas AND a global daily cap. No feature
  ships that can call a paid API outside the metering path.

## 7. Testing

- Behavior tests are written BEFORE implementation (each loop phase encodes this).
- Fixtures over mocks-of-everything: real transcripts, real WAVs, scripted mock vendors.
- The A/B user-isolation tests (RLS) are the crown jewels — they run in CI on every PR,
  and a failure blocks everything.
- `npm run check` (typecheck + lint + tests + migration shadow-apply) green = mergeable;
  anything less is not "done."
- **`npm run check` green is necessary, not sufficient.** Every PR also gets a CodeRabbit
  review (`coderabbit review --agent --base development`, or `/coderabbit:review` in
  Claude Code). The reviewer runs on the `assertive` profile against `.coderabbit.yaml`,
  which encodes this document as `path_instructions` — so a finding there is a RULES
  violation, not an opinion. Critical and Warning findings are fixed or explicitly
  argued down in the PR before merge; silently ignoring one is not an option.
- **A suite is never made green by removing coverage.** `it.skip` / `it.only` / `it.todo`
  are lint errors (`vitest/no-disabled-tests`, `no-focused-tests`, and a `no-restricted-syntax`
  ban on `.todo` — which discards the test body and still reports green). A test with no
  assertion is also an error (`vitest/expect-expect`; shared `expect*` helpers count).
  The sanctioned way to not run a test is a RUNTIME condition — `describe.skipIf(!key)`
  for the key-gated live smokes and DB integration suites — because it self-skips
  without a key and runs for real with one.

## 8. Living documentation (docs-as-code)

- **Any PR that changes architecture, data model, or behavior updates the docs in the
  same PR**: `docs/ARCHITECTURE.md` (how it works now), an ADR in `docs/DECISIONS/`
  (why we chose this), `docs/PARITY.md` (feature checklist status), `CLAUDE.md`
  (commands/gotchas for AI agents). The PR template has a docs checkbox; reviewers
  enforce it.
- Docs describe the PRESENT. History lives in git and ADRs, not in "old section kept
  just in case" clutter.
- A new contributor (or a fresh AI session) must be able to onboard from
  `README.md → docs/ARCHITECTURE.md → docs/RULES.md` alone.

## 9. Use as reference

The reference repo (`~/Documents/natively-cluely-ai-assistant`) Nova is built from
industry-standard public patterns and this repo's own specs. Feature-level inspiration
(what the product does) is tracked in `docs/PARITY.md`; Use what they do, learn from what they do. And implement thing using this repo's proven methods.

## 10. Code style — beautiful, readable, maintainable (stack-specific)

Style is enforced by tools, not vibes: **Prettier** (formatting — zero debate) +
**typescript-eslint `strict-type-checked`** presets, committed configs, run in
`npm run check` and CI. What tools can't enforce, review does.

**Mechanically enforced** (`eslint.config.mjs` — these fail the build, they are not
advisory):
- Vendor SDKs importable ONLY inside `modules/*/adapters/**` (§ports-and-adapters,
  `no-restricted-imports`). Adding a vendor means adding it to `VENDOR_SDKS` there.
- No reach-around imports four levels or deeper (`../../../../`). Three levels is
  allowed because `modules/*/adapters/` legitimately sits that deep; enforcing the
  stricter no-`../../../` wording below needs workspace path aliases first.
- Import order, autofixable with `eslint --fix`.
- Every `eslint-disable` carries a `-- why: …` on the SAME line
  (`eslint-comments/require-description`), and a disable that stopped being needed
  fails the build (`no-unused-disable`).
- `@ts-ignore` and `@ts-nocheck` are banned outright; `@ts-expect-error` needs a
  ≥10-char reason.
- The testing anti-cheat rules in §7.

### TypeScript / server (Node 20+, Fastify)
- **ES modules everywhere** (`"module": "NodeNext"`); no CommonJS in new code.
- **Naming:** `camelCase` variables/functions · `PascalCase` types/classes/zod-schema
  exports (`MeetingSchema`) · `UPPER_SNAKE_CASE` true constants · file names
  `kebab-case.ts` (matching module anatomy: `service.ts`, `routes.ts`, `ports.ts`).
  Booleans read as predicates (`isFinal`, `hasQuota`, `canRetry`).
- **Functions stay small and single-purpose;** extract when a function needs a comment
  to separate its sections. Early returns / guard clauses over nested `if` pyramids —
  the happy path reads top-to-bottom at the end.
- **No nested ternaries.** No clever one-liners that need re-reading.
- **`async/await` only** — no `.then()` chains, no callback style. Every promise is
  awaited or explicitly `void`-ed with a comment (`no-floating-promises` is a CI error).
- **Model states with discriminated unions, not boolean soup:**
  `{ status: 'queued' | 'processing' | 'completed' | 'failed' }` beats
  `isProcessing`/`isDone`/`hasFailed`. Exhaustive `switch` with a `never` check so
  adding a state breaks the build until every consumer handles it.
- **Derive types, don't duplicate:** `z.infer<typeof MeetingSchema>` — never a
  hand-written twin interface next to a schema.
- **Prefer `const`; prefer immutability** (`readonly` on interfaces, spread over
  mutate) except in measured hot paths (comment why).
- **Comments explain WHY, never narrate WHAT.** A `// why:` is required for every
  workaround, cast, or surprising choice. Dead code is deleted, not commented out —
  git remembers.
- **Import order:** node builtins → external deps → workspace packages → relative;
  auto-sorted by the linter. No `../../../` reach-arounds — path aliases per workspace.

### React Native / Expo (mobile)
- **Function components + hooks only.** Screens stay dumb (render + navigation);
  logic lives in custom hooks (`useLiveSession`, `useMeetingNotes`) — testable and
  reusable. One component per file, `PascalCase.tsx`.
- **Feature-first folders** (`features/live-call/`, `features/history/`) — group by
  what it does, not what it is; shared primitives graduate to `components/ui/`,
  never copy-pasted between features.
- **All styling via `theme/tokens.ts`** (RULES §2) — no inline hex, no magic numbers.
  `StyleSheet.create` / styled primitives over inline object literals in JSX.
- **Every data-driven screen designs its four states:** loading / empty / error /
  happy — no blank screens, no spinner-forever (loop Phase 8 verifies this).
- **Lists are `FlatList`/`FlashList`** (never `.map` inside `ScrollView` for
  unbounded data). Memoize (`memo`/`useMemo`/`useCallback`) only where a re-render is
  *measured* to matter — premature memo is clutter.
- **Error boundaries** around each feature surface so one failure can't take down the
  whole screen.

### SQL / Supabase
- **`snake_case`, plural table names** (`meetings`, `usage_events`); primary key `id`;
  timestamps `*_at timestamptz` (always timezone-aware); FK columns `<table_singular>_id`.
- **Explicit column lists in application queries** — `SELECT *` only in ad-hoc
  debugging, never in code.
- Migration/script style is governed by §4; RLS policies named
  `<table>_<action>_<who>` (`meetings_select_own`).

## 11. Secrets & config

- No secrets in the repo, ever — `.env` files are gitignored; `.env.example` documents
  every variable with a fake value.
- Real secrets live in GitHub Environments (CI/CD) and local `.env` only.
- Vendor API keys are server-side only. The mobile app never holds a vendor key —
  it holds a Nova session token, full stop.
