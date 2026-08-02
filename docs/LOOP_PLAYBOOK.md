# Nova — Loop Playbook

Phased, self-verifying loop prompts for building Nova. Built on the loop-engineering
framework (GOAL / VERIFY BY / PLAN / STOP WHEN). Run **one phase at a time, in order** —
each loop's STOP condition is the next loop's entry ticket.

> Living document (RULES.md §8). Supersedes `~/Downloads/copilot-loop-playbook.md`.

**Stack (ADR-0001):** TypeScript/Node server (Fastify) · Supabase (auth + Postgres/RLS +
pgvector) · React Native + Expo · AssemblyAI primary / Deepgram Nova-3 fallback STT ·
multi-LLM routing (Anthropic / OpenAI / Google / Groq).

---


## Global guardrails (paste into every loop session)

```
GUARDRAILS:
- Obey docs/RULES.md — it outranks convenience. Highlights: zod-parse every boundary;
  vendor SDKs only in adapters/; soft delete always; expand→backfill→contract
  migrations; RLS ships with tables; no unmetered vendor calls.
- Work on a dev-<who>-<topic> branch off development; PR into development ONLY
  (never staging/main). Update ritual: merge development INTO the feature (never the
  reverse) → re-test → push. Merge commits, no squash, keep branches after merge.
  npm run check green before "done". AI PRs wait for Gustavo's merge go-ahead.
- Budget: 5 failed attempts on a step with no new information → STOP and summarize
  what was tried, learned, and what you'd try next.
- Checkpoint: verify after EACH plan step, never only at the end.
- Real verification only: no passing test/build/screenshot = not done. If no test
  exists, writing one IS step 1.
- Surgical diffs: after each step check `git diff --stat`; revert unrelated edits.
- LIVING DOCS: before closing the loop, update docs touched by the change
  (ARCHITECTURE.md, PARITY.md status column, ADRs, CLAUDE.md commands) in the SAME
  branch. A loop that changed behavior but not docs is NOT done.
- PARITY: check off the phase's rows in docs/PARITY.md with links to the evidence.
- Never read from ~/Documents/natively-cluely-ai-assistant.
- Commit after each verified step; message names the loop + step.
```

**Does this playbook verify feature-completeness, not just code correctness?**
Yes — via `docs/PARITY.md`: every public-level capability of the reference product maps
to a phase and a verification. A phase's loop is complete only when its parity rows
flip to ✅ with evidence. That's the guard against "we built it well but forgot a
feature."

---

## Phase 0 — Repo, GitHub, and monorepo scaffold

```
GOAL: The nova monorepo exists at ~/Documents/nova with three workspaces that build,
      typecheck, and talk to each other (apps/mobile Expo, apps/server Fastify,
      packages/shared). The GitHub repo (GusDawn123/nova, private, branches
      main/staging/development, merge-commit-only settings, PR template) already
      exists — this phase adds the real CI. Supabase dev project connected.
VERIFY BY: Mechanical checks only:
  - Work happens on dev-<who>-<topic> branches PR'd into development per
    GIT_WORKFLOW.md — confirmed by the PR history itself
  - ci.yml (replacing the placeholder) runs on a test PR and passes (typecheck +
    lint + test + supabase shadow migration replay)
  - `npm run typecheck` and `npm run check` pass at repo root
  - Server starts locally; GET /health returns { ok: true, version }
  - Expo app boots in simulator and renders the /health response fetched from the
    local server (app↔server round trip proven; screenshot)
  - Server reads/writes a `_smoke` table on the nova-dev Supabase project
  - docs/ and CLAUDE.md updated with the real commands (LIVING DOCS guardrail)
PLAN:
  1. Branch dev-claude-scaffold off development; npm workspaces + TS project refs
     scaffold → verify: typecheck passes
  2. Real ci.yml (typecheck, lint, test, supabase shadow replay) replacing placeholder
     → verify: test PR goes green
  3. Fastify server: /health, boot-time zod env parse, request-id logging plugin
     → verify: curl /health
  4. Expo app (TS template, expo-router) fetching /health → verify: simulator screenshot
  5. Supabase: create nova-dev project, `supabase init` + `supabase start` locally,
     _smoke migration → verify: integration test
  6. Update CLAUDE.md commands + ARCHITECTURE.md status → verify: docs reflect reality
  7. PR to development → Gustavo merges
STOP WHEN: All verifies pass, or budget hit.
```

---

## Phase 1 — Auth + per-user data isolation (the foundation)

```
GOAL: Users can sign up / sign in / sign out from the mobile app (email + Apple +
      Google via Supabase Auth), and the database enforces per-user isolation so
      User A can NEVER read User B's rows — enforced by Postgres RLS, not app code.
VERIFY BY: Automated tests with two real test users (A and B):
  - A signs up, gets a session token; server middleware resolves token → user id
  - Tables profiles, meetings, transcripts, context_docs exist with RLS ON and
    deleted_at soft-delete columns (RULES §3, §4.9)
  - A inserts a meeting; B queries meetings WITH B'S JWT DIRECTLY against Supabase
    → 0 rows (not app-layer filtering)
  - Soft-delete respected: A "deletes" a meeting → it vanishes from A's queries but
    the row exists with deleted_at set
  - No/expired token → 401 from server middleware
  - In-app account deletion queues purge (Apple mandate) → deletion test passes
PLAN:
  1. Migrations (expand-style, RLS + policies in same file as each table) → verify:
     fresh replay + drift check green
  2. RLS isolation A/B tests → verify: all pass (these become permanent CI blockers)
  3. Server auth middleware (JWT → user context) → verify: 401/200 tests
  4. Mobile auth screens + session persistence across restarts → verify: simulator
     flow + screenshot
  5. Account deletion endpoint + button + purge queue → verify: deletion test
  6. PARITY rows 29-31 → ✅; docs updated
STOP WHEN: Every test passes. RLS failures = hard stop for everything downstream.
```

---

## Phase 2 — LLM provider router (the engine's brain stem)

```
GOAL: modules/llm streams chat completions through an ordered provider list
      (Anthropic, OpenAI, Google, Groq — each behind ports.ts/adapters/) with
      automatic failover, such that one provider being slow/dead/misconfigured is
      invisible to the caller.
VERIFY BY: Unit tests against MOCK providers (scriptable failure modes; no real API
  calls). Required behaviors, each its own named test:
  - [race]    Primary yields first token within TTFT_TIMEOUT (default 2500ms,
              config-tunable) or the router silently moves on.
  - [commit]  First non-empty token = commitment: NEVER switch providers mid-response;
              post-commit failure ends the stream gracefully, no mixed output.
  - [stall]   Committed stream silent > STALL_TIMEOUT (default 20s) → aborted with
              typed error.
  - [breaker] N consecutive failures (default 5) opens that provider's circuit for
              COOLDOWN (default 30s); success closes it.
  - [classify] Auth errors (401/403) bench a provider far longer than transient
              errors (5xx/timeout), which retry with backoff.
  - [empty]   All providers down → one typed error, never a hang.
  - [order]   Priority order + per-request overrides respected.
PLAN:
  1. ports.ts Provider interface + scriptable mock harness → verify: harness simulates
     every failure mode
  2. Write ALL behavior tests first → verify: they exist and FAIL
  3. Implement router one behavior at a time → verify: each test flips green
  4. Four real adapters (thin, SDKs only here) → verify: live smoke per provider with
     real keys (CI-skippable), through the metering interface stub
  5. PARITY row 11 → ✅; ARCHITECTURE module map updated
STOP WHEN: All behavior tests pass + live smoke on ≥2 providers.
```

---

## Phase 3 — Streaming STT gateway (the ears)

```
GOAL: modules/stt accepts a live audio stream over authenticated WebSocket, relays to
      AssemblyAI streaming (primary) with Deepgram Nova-3 fallback (both behind
      adapters), and emits zod-validated transcript events { text, isFinal, speaker,
      ts } — including diarization from a single mixed mic feed. Raw audio is never
      written to disk (RULES §3).
VERIFY BY:
  - Fixture test: stream a 60s two-speaker WAV (create clean + noisy/speakerphone-
    simulated copies) → (a) interim transcripts arrive DURING streaming; (b) final
    word-overlap vs reference text ≥ 80% (clean); (c) ≥2 speaker labels with turn
    boundaries within ±2s of the fixture's known turns
  - Failover: AssemblyAI config pointed at dead endpoint → same fixture transcribes
    via Deepgram + provider_switched event emitted
  - Reconnect: kill vendor socket mid-stream → gateway reconnects with backoff;
    client socket never drops
  - Isolation: concurrent sessions for users A + B → zero cross-contamination
  - Noisy copy: word-overlap ≥ 70% (speakerphone reality bar)
  - Storage audit: no audio bytes persisted anywhere (grep + storage inspection)
PLAN:
  1. Auth'd WS endpoint + session lifecycle → verify: echo test
  2. AssemblyAI adapter → verify: fixture (a)(b)(c) clean
  3. Deepgram adapter + failover → verify: failover test
  4. Reconnect/backoff → verify: reconnect test
  5. Concurrency isolation → verify: isolation test
  6. Noisy fixture → verify: ≥70% bar
  7. PARITY rows 1-3, 5, 34 → ✅; docs updated
STOP WHEN: All tests pass, both fixtures meet their bars.
```

---

## Phase 4 — RAG memory: "full context on your life"

```
GOAL: modules/rag stores per-user context (profile, docs, notes) and auto-indexes
      finished call transcripts, behind four ports (Chunker, Embedder, VectorStore,
      Reranker — pgvector is just an adapter, RULES §5). RagService.query returns
      relevant snippets strictly scoped to the requesting user.
VERIFY BY:
  - Seed test: ingest 20 fixture docs for user A → semantic query "what pricing did
    we offer Acme?" returns the known snippet in top-3 (assert by doc id)
  - Isolation: same query as user B → zero of A's snippets (RLS on embeddings table,
    tested with B's JWT directly)
  - Freshness: finished fixture call → chunks queryable within 60s, no manual action
  - Latency: p95 query < 300ms on a 10k-chunk corpus (benchmark prints the number)
  - Versioning: embeddings rows carry model name + dims (RULES §5)
PLAN:
  1. Migrations: context_docs, chunks, embeddings + RLS + soft delete → verify:
     replay + RLS test
  2. Ingestion (chunk → embed → store) behind ports → verify: seed test
  3. Query API (embed → vector search → rerank) → verify: top-3 test
  4. Auto-index on call completion → verify: freshness test
  5. Benchmark script → verify: latency number under target
  6. PARITY rows 24-25 → ✅; docs updated
STOP WHEN: All green. Top-3 accuracy still failing after 3 tuning rounds (chunk size /
           overlap / reranker) → stop and present options.
```

---

## Phase 5 — Post-call notes pipeline (the MVP hero)

```
GOAL: When a call ends, modules/notes produces structured notes — title, tl;dr,
      overview, decisions[], actionItems[{text, owner, deadline}], openQuestions[],
      risks[] — shaped by conversation type (sales / interview / casual), plus a
      copy-ready follow-up draft. Stored on the meeting row, visible in the app,
      regenerable on demand.
VERIFY BY:
  - Schema: zod-validated output; invalid LLM output → one repair round-trip → minimal
    valid fallback. Malformed notes are UNREPRESENTABLE in the DB (RULES §1).
  - Fixtures: 3 transcripts (sales, interview, casual) → hand-labeled expected facts
    appear (e.g. action item "send proposal by Friday" with owner + deadline), and the
    three note shapes differ appropriately
  - Long call: 90-min fixture exceeding single-context → chunk → per-chunk summarize →
    reduce; facts from BOTH first and last 10 minutes present
  - Recovery: kill worker mid-processing → restart detects unprocessed meeting,
    re-queues; status walks queued → processing → completed/failed-with-retry
  - Follow-up draft cites ONLY items present in the final notes object (never raw
    transcript, never invented commitments)
  - Cost: token usage per summary logged per user (feeds Phase 6)
PLAN:
  1. zod schema + repair/fallback ladder → verify: schema test
  2. Single-pass pipeline + type-aware prompts → verify: 3 fixture tests
  3. Map-reduce path for long calls → verify: long-call test
  4. Job queue + status + crash recovery → verify: recovery test
  5. Follow-up draft generator + tones + regenerate endpoints → verify: cites-notes-only
     + regenerate tests
  6. PARITY rows 13-22 → ✅; docs updated
STOP WHEN: All tests pass. Fixture fact-checks failing after 4 prompt iterations →
           stop, show outputs side-by-side, ask for direction.
```

---

## Phase 6 — Usage metering, quotas, billing hooks (the bar tab)

```
GOAL: Every expensive operation (STT seconds, LLM tokens) is metered per user through
      modules/metering; plan-based quotas enforce limits; exceeding quota degrades
      gracefully (typed error + paywall state) — never a silent bill explosion.
VERIFY BY:
  - Metering: fixture call end-to-end → usage_events record STT seconds + LLM tokens
    within 5% of vendor-reported usage
  - Quota: test user capped at 1 minute → second minute refused with QUOTA_EXCEEDED;
    app shows paywall state
  - Rate limit: 100 rapid requests, one user → throttled; server stays healthy
  - Concurrency: same user, 3 simultaneous live sessions → refused (one live call/user)
  - Kill-switch: global daily spend cap reached → new sessions refused, in-flight ones
    finish, alert fires
  - Audit: grep-level check that NO code path reaches a vendor adapter without passing
    metering (RULES §6)
PLAN:
  1. usage_events migration + metering middleware wrapping all adapters → verify:
     metering test + audit
  2. Plans/quotas enforced at session start AND mid-stream → verify: quota test
  3. Rate limits + concurrency caps → verify: those tests
  4. Global kill-switch + alert → verify: kill-switch test
  5. RevenueCat webhook (zod-parsed) mapping purchases → plans → verify: fixture
     webhook upgrades a test user
  6. PARITY rows 32-33, 35 → ✅; docs updated
STOP WHEN: All green. This phase GATES external TestFlight — no outside testers until
           the kill-switch test passes.
```

---

## Phase 7 — Live copilot loop (the spicy feature)

```
GOAL: During a live session, the server watches the rolling transcript and pushes
      streaming suggestions (answer this / say this next / relevant context from RAG)
      fast enough to matter mid-conversation — first tokens on the wire immediately,
      never buffered until complete (rendered client-side as the single streaming
      pane, live-pipeline.md Mobile).
VERIFY BY:
  - Latency: from a fixture "question moment" to first suggestion token on the client
    socket: p50 < 2s, p95 < 4s (benchmark prints numbers; mock LLM with realistic
    delay + real router)
  - Relevance: 10 fixture moments with hand-labeled topics → suggestion references the
    expected topic ≥ 7/10 (keyword rubric, not vibes)
  - Grounding: fixture question about the user's own history ("what did we quote them
    last time?") → suggestion contains the Phase-4 stored fact
  - Quiet: labeled small-talk windows → ZERO suggestions (spam is the #1 uninstall
    driver)
PLAN:
  1. Rolling transcript state + trigger detection → verify: fires on labeled moments,
     silent in no-op windows
  2. Suggestion generation through the Phase-2 router, streaming → verify: latency
  3. RAG injection → verify: grounding test
  4. Push over live socket + minimal streaming-pane render (deltas append as they
     arrive; replace on start, clear on discard) → verify: streamed suggestion visibly
     builds up in simulator during a replayed fixture call (full pane polish = Phase 8)
  5. PARITY rows 7-10 (+12 if built) → ✅; docs updated
STOP WHEN: Latency + quiet pass and relevance ≥ 7/10; below that after 4 prompt/trigger
           iterations → stop and present the failing transcripts for human judgment.
```

---

## Phase 8 — Mobile UI loops (visual verification, per screen)

Run one loop **per screen**: Home/history · Live call · Meeting detail (notes tabs) ·
Context/profile ("your life") · Settings/paywall. All styling through theme/tokens.ts
(RULES §2).

```
GOAL: [Screen] renders correctly at 390x844 and 375x667, light AND dark mode.
VERIFY BY: Screenshot each state (simulator, or Expo web + Playwright for layout
  checks), then check item by item:
  - [ ] No overlapping elements; no horizontal overflow
  - [ ] Text contrast readable in both themes (spot-check smallest text)
  - [ ] Primary action visible without scrolling
  - [ ] Loading, empty ("no meetings yet"), and error states all designed — forced
        via mock data, never left blank
  - [ ] Live-call screen: transcript autoscrolls; suggestion card readable at a
        glance (used mid-conversation under stress — size up)
  - [ ] Touch targets ≥ 44pt
PLAN:
  1. Build screen with mock data for every state → screenshot each
  2. Check list per screenshot → fix failures one at a time → re-screenshot
STOP WHEN: All items pass at both sizes and themes, or 4 rounds without a full pass —
           then show the screenshots and ask for direction.
```

---

## Phase 9 — End-to-end acceptance (the graduation test)

```
GOAL: The full product loop works on a REAL device: sign in → start session →
      speakerphone audio of a 2-person fixture conversation plays into the phone's
      mic → live transcript + ≥1 relevant suggestion appear → end call → structured
      notes with correct action items in history within 90s → usage metered → all of
      it isolated to that user (second account verifies).
VERIFY BY: Scripted checklist on a physical iPhone (Expo dev build), every step
  screen-recorded. A second test account confirms isolation afterward. No step
  "verified" from memory. PARITY rows 4 + remaining E2E rows → ✅.
STOP WHEN: Full checklist passes twice in a row on a physical device. This is the
           TestFlight gate.
```

---

## Order of battle & dependencies

```
0 → 1 → 2 → 3 → 4 → 5 → 6 → 9(gate)          ← MVP: the NOTETAKER ships here
                 └──→ 7 → 8-live-screen → 9    ← fast-follow: LIVE COPILOT
8 (UI screens) runs in parallel any time after 1.
```

Notetaker (5) before live copilot (7) is deliberate: lower-risk hero feature (the
market leader's mobile app leads with it), and every phase it needs, the live copilot
needs anyway.
