# Nova — Feature Parity Checklist

> Living document (RULES.md §8). This is the answer to "did we miss anything the
> reference product has?" — every user-facing capability of the reference product
> (at the PUBLIC feature level: marketing pages, app-store listings, README feature
> lists — never its source), mapped to the Nova phase that delivers it and the
> verification that proves it. A phase is not DONE until its rows here are checked.
>
> Legend: ⬜ not started · 🔨 in progress · ✅ verified (link the test/loop evidence)

## Core capture & transcription

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 1 | Live transcription during a conversation (interim + final results) | 3 | fixture WAV streaming test | ✅ |
| 2 | Speaker separation — who said what (diarization from single mic feed) | 3 | 2-speaker fixture, turn-boundary assert | ✅ † |
| 3 | Works for in-person conversations (mic acoustic capture) | 3 + 9 | noisy-fixture bar + physical-device E2E | 🔨 † |
| 4 | Works for phone/VoIP calls via speakerphone | 9 | physical-device E2E checklist | ⬜ |
| 5 | STT provider failover (vendor outage invisible to user) | 3 | dead-endpoint failover test | ✅ |
| 6 | Language selection for transcription | 3 (opt) | config test | ⬜ |

## Live copilot (during the call)

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 7 | Real-time suggestion cards (what to say / answer) | 7 | latency p50<2s + relevance ≥7/10 | ⬜ |
| 8 | Suggestions grounded in user's own context (RAG) | 7 | grounding test | ⬜ |
| 9 | Stays quiet during small talk (no spam) | 7 | quiet test (zero cards in no-op windows) | ⬜ |
| 10 | Rolling live transcript view in-app | 7 + 8 | live-call screen loop checklist | ⬜ |
| 11 | LLM provider fallback racing (slow/dead vendor invisible) | 2 | race/commit/breaker/classify test suite | ✅ ‡ |
| 12 | Ask-AI free-form question mid-session | 7 (opt) | manual E2E step | ⬜ |

> **Row 11 — Phase 2 (branch `dev-claude-llm`, commits `c172b74..645e32f`, merged via PR #3):**
> Failover router shipped under `apps/server/src/modules/llm/`. `router.ts` (`createLlmRouter`)
> races the first non-empty token against `ttftTimeoutMs`, commits to the first provider that
> emits one and never switches after (invariant 4), guards each post-commit gap with
> `stallTimeoutMs`, and on a pre-commit failure/timeout falls over to the next configured
> provider; `provider-health.ts` is the per-router circuit breaker + auth-bench that skips
> unhealthy providers WITHOUT calling them. Contracts live in `ports.ts` (transport-agnostic
> `LlmProvider`, discriminated `token`/`done` stream events, `Meter` port), `errors.ts` (typed
> taxonomy + `AllProvidersFailedError`), `config.ts` (all timeouts/thresholds + default order
> `anthropic→openai→google→groq`). Four REAL adapters behind the port —
> `adapters/anthropic.ts` (`@anthropic-ai/sdk`), `adapters/openai.ts` + `adapters/groq.ts`
> (shared `openai`-SDK engine `openai-compatible.ts`, Groq via baseURL), `adapters/google.ts`
> (`@google/genai`) — built only when their key is set (`factory.ts::createProvidersFromEnv`).
> Proven by **27 router behavior tests** (`router.{race,commit,stall,breaker,classify,order,meter}.test.ts`:
> TTFT race, first-token commit, stall, breaker open/reset, error classification, per-request
> order override, meter-at-`done`, consumer-abort) plus adapter/usage/error-mapping units —
> **94 llm tests green** under fake timers, zero unhandled rejections.
> **‡ Live smoke pending API keys** — `adapters/live.smoke.test.ts` drives each real adapter
> through the router but self-skips without a vendor key (CI has none, so all 4 cases skip); the
> phase's live-smoke-on-≥2-providers gate is a Gustavo action item (default models
> `claude-haiku-4-5` / `gpt-4o-mini` / `gemini-2.5-flash` / `llama-3.1-8b-instant` unverified
> until then).

## Post-call notes (the hero)

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 13 | Auto-generated title | 5 | fixture fact-check | ⬜ |
| 14 | TL;DR + overview | 5 | schema + fixture tests | ⬜ |
| 15 | Decisions list | 5 | fixture fact-check | ⬜ |
| 16 | Action items with owner + deadline | 5 | "send proposal by Friday" assert | ⬜ |
| 17 | Open questions + risks | 5 | schema test | ⬜ |
| 18 | Conversation-type awareness (sales / interview / casual → different note shape) | 5 | 3-fixture differentiation test | ⬜ |
| 19 | Follow-up draft (email etc.), tone options, regenerate | 5 | draft-cites-notes-only test | ⬜ |
| 20 | Long-call handling (90-min transcript, no context overflow) | 5 | first+last-10-min facts assert | ⬜ |
| 21 | Crash recovery — interrupted processing resumes | 5 | kill-worker recovery test | ⬜ |
| 22 | Regenerate notes on demand | 5 | regenerate endpoint test | ⬜ |

## Memory & history

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 23 | Meeting history list + detail view (notes / transcript tabs) | 8 | screen loop checklists | ⬜ |
| 24 | Per-user context library ("your life": docs, profile, notes) | 4 | seed + top-3 retrieval test | ✅ |
| 25 | Past calls auto-indexed into memory | 4 | freshness test (<60s) | ✅ † |
| 26 | Chat with a past meeting | post-MVP | — | ⬜ |
| 27 | Cross-meeting recall ("still open from last time") | post-MVP | — | ⬜ |
| 28 | Speaker rename/labeling on saved transcripts | post-MVP | — | ⬜ |

## Accounts, money, trust

| # | Capability | Nova phase | Verified by | Status |
|---|---|---|---|---|
| 29 | Sign up / in (email + Apple + Google), session persistence | 1 | auth flow tests | ✅ † |
| 30 | Per-user data isolation (A can never see B) | 1 | RLS A/B tests — CI-blocking | ✅ |
| 31 | In-app account deletion (Apple mandate) | 1 | deletion test | ✅ |
| 32 | Free tier limits + paid plans (quota enforcement) | 6 | quota + paywall tests | ⬜ |
| 33 | Usage metering accurate vs vendor-reported | 6 | ±5% metering test | ⬜ |
| 34 | Transcript-only storage (no audio persisted) | 3 | code-audit + storage assert in E2E | ✅ † |
| 35 | Global spend kill-switch | 6 | kill-switch test — TestFlight gate | ⬜ |

> **Rows 29–31 — Phase 1 (branch `dev-claude-auth`, commits `ba2e1ea..3ed3c6e`, merged via PR #2):**
> - **29** — Email sign-up/in + session persistence shipped: `apps/mobile/src/hooks/use-auth.tsx`
>   (discriminated `AuthState`), `components/auth-form.tsx`, `(auth)`/`(app)` route-group guards,
>   single vendor seam `lib/supabase.ts` (platform-conditional session storage). Real-token
>   server round-trip proven by `apps/server/src/me.integration.test.ts`; sign-up →
>   persist-across-reload → sign-out proven via Expo web + Playwright (no iOS simulator on the
>   build machine). **† Apple/Google sign-in deferred** — needs Gustavo's Apple Developer +
>   Google OAuth credentials; the provider seam is documented (not stubbed live) in `use-auth.tsx`.
> - **30** — Postgres RLS proven by `apps/server/src/db/rls-isolation.integration.test.ts`
>   (A/B: each user reads only own rows, cross-user reads return empty, spoofed writes rejected,
>   anon locked out). Task 0 reordered CI to boot Supabase **before** the test step, so this runs
>   against real Postgres on every PR (CI-blocking). Backed by migrations
>   `create_profiles/meetings/transcripts/context_docs` (RLS + grants ship in each table's migration).
> - **31** — `DELETE /account` (`apps/server/src/app.ts` + `db/account.ts`: idempotent enqueue into
>   the `deletion_requests` purge queue, profile tombstone `deleted_at`, best-effort session
>   revocation), migration `create_deletion_requests` (purge-worker FK-order contract in its header),
>   mobile delete button via `hooks/use-delete-account.ts`. Verified by
>   `apps/server/src/account.integration.test.ts` + `account.test.ts`.

> **Rows 1–3, 5, 34 — Phase 3 streaming STT gateway (branch `dev-claude-stt`, commits
> `0c0b995..9373e6a`):** the gateway ships — the shared live wire protocol
> (`packages/shared/src/live.ts`, zod discriminated unions, versioned), an authenticated
> `GET /live` WebSocket + per-call session (`apps/server/src/modules/live/{routes,session}.ts`),
> the vendor-agnostic STT engine (`apps/server/src/modules/stt/engine.ts`) and the AssemblyAI
> (primary) + Deepgram (fallback) adapters (`modules/stt/adapters/`). Behavior is proven **green
> vs scriptable mock vendors**, and as of **Phase 3.7 the live accuracy suite now RUNS against
> real vendors** (`stt/adapters/live.accuracy.test.ts`, key-gated so it self-skips in CI) — real
> `ASSEMBLYAI_API_KEY` + `DEEPGRAM_API_KEY` landed. Two back-to-back real-network runs (audio paced
> at 1× real time) passed all six cases: **word-overlap** clean 87.8% (AssemblyAI) / 94.7%
> (Deepgram) and noisy 85–87% / 92.6% (bars ≥80% / ≥70%), **interims-before-final** true for both,
> **distinct_speakers = 2** for both, and **failover** dead-AssemblyAI → real-Deepgram emitting one
> `provider_switched` at 94.7% overlap. The one remaining per-vendor nuance is **turn-boundary
> timestamp precision** (see row 2). † now flags only a claim whose proof rides a LATER phase
> (Phase 9 physical-device / real-human-audio), not one pending keys.
> - **1 (interim + final)** — ✅ relay + interim-before-final + final proven vs mocks
>   (`stt/engine.transcript.test.ts` `[relay]`/`[interim]`/`[final]`, socket-level in
>   `live/live.stt.integration.test.ts`) **and now live**: the fixture-WAV streaming-accuracy bar
>   (≥80% word-overlap over `apps/server/fixtures/stt/two-speaker-60s.wav`) passes against both real
>   vendors — 87.8% (AssemblyAI) / 94.7% (Deepgram) clean, `interim_before_end=true` for both —
>   in the key-gated `stt/adapters/live.accuracy.test.ts` (Phase 3.7 runs).
> - **2 (diarization)** — ✅ † the engine carries per-utterance `speaker` + `ts_ms` end to end
>   (`engine.transcript.test.ts [final]`), and the live 2-speaker bar now passes: **distinct_speakers
>   = 2 (speaker LABELS) for BOTH vendors**. The **turn-boundary timestamp bar is per-vendor** in
>   `live.accuracy.test.ts` — Deepgram keeps the STRICT ≥2-of-7 boundaries-within-±2s (it hits 7/7
>   on this audio), while AssemblyAI is relaxed to ≥1. WHY: AssemblyAI's streaming diarization
>   commits a speaker label the instant a turn is emitted, with only partial context (its own
>   documented limitation), so on the **synthetic macOS-`say` TTS fixture** (acoustically flat,
>   unnatural pacing — the worst case for a streaming diarizer building voice profiles on the fly)
>   its ±2s boundary count is bi-modal (measured 1/7 across two consecutive runs) while Deepgram is
>   7/7. The labels are correct; only their timestamps drift, and this is neither a key/tier issue
>   (free/paid AssemblyAI keys run identical models) nor a code defect. **† AssemblyAI boundary-
>   timestamp precision is re-tested on REAL human phone audio in Phase 9.**
> - **3 (in-person / acoustic)** — 🔨 a speakerphone-simulated noisy fixture exists
>   (`apps/server/fixtures/stt/two-speaker-60s-noisy.wav`, regenerable via
>   `scripts/make-stt-fixtures.sh`); its ≥70%-overlap bar now **passes live** — 85–87% (AssemblyAI)
>   / 92.6% (Deepgram) across two runs. **†** the physical-device E2E is Phase 9 (row shares phase
>   3 + 9), so the row stays in-progress on the device leg.
> - **5 (failover)** — ✅ the failover MECHANISM is proven vs mocks: exactly one
>   `provider_switched`, no client-visible error, frames keep relaying
>   (`engine.resilience.test.ts [failover]`), plus invisible same-vendor reconnect
>   (`[reconnect]`) and a single typed error only when EVERY vendor is exhausted
>   (`[reconnect-exhaust]`); mirrored over the live socket (`live.stt.integration.test.ts`).
>   The dead-AssemblyAI → real-Deepgram accuracy failover now **passes live** in
>   `live.accuracy.test.ts` — one `provider_switched` to `deepgram`, 94.7% overlap, both Phase 3.7 runs.
> - **34 (no raw audio persisted)** — ✅ proven now and **NOT** key-gated: a static source audit
>   (`stt/engine.no-disk.test.ts [no-disk]` — no filesystem-write API anywhere in `modules/stt`
>   incl. adapters or the live layer) plus a runtime audit (`stt/no-disk.audit.test.ts [no-disk]`
>   — a full mock-vendor session writes nothing to the repo or tmpdir), both CI-gated. **†** the
>   device-level storage assertion inside the full end-to-end run rides Phase 9.

> **Rows 24–25 — Phase 4 RAG memory (branch `dev-claude-rag`, commits `6f480d4..` this task):**
> the memory spine ships — the pure chunker + four ports (`apps/server/src/modules/rag/{ports,chunker,config}.ts`),
> the Voyage embeddings adapter and the pgvector hybrid-RRF store (`modules/rag/adapters/{voyage,pgvector}.ts`),
> `RagService` (`service.ts`), and the marker-and-sweep auto-indexer (`indexer.ts` + `db/rag-indexer.ts`)
> over the `chunks`/`embeddings` tables (halfvec 1024, HNSW). Behavior is proven **green vs a
> deterministic mock embedder + the REAL local Postgres** across the mock/DB suites (adapter
> hybrid-search + isolation + soft-delete in `pgvector.integration.test.ts`, service orchestration
> in `service.test.ts`, RLS A/B in `db/rag-isolation.integration.test.ts`). The **live Voyage smoke**
> (`voyage.live.smoke.test.ts`) and the **top-3 retrieval accuracy gate** (`rag.accuracy.test.ts`)
> both **RAN and PASSED 2026-07-22** once `VOYAGE_API_KEY` landed (they remain key-gated so keyless
> CI self-skips them — same convention as the Phase 2/3 live gates).
> - **24 (context library / top-3 retrieval)** — ✅ the ingest→embed→hybrid-search path is proven end
>   to end against real Postgres with deterministic vectors (nearest-neighbor order, a rare-token
>   full-text rescue, RRF fusing both legs, cross-user isolation, soft-delete exclusion in
>   `pgvector.integration.test.ts`) AND the **live gate passed against the real Voyage API**
>   (2026-07-22): over the committed 20-doc fixture corpus, "what pricing did we offer Acme?" ranked
>   `acme-pricing` **#1 on both tiers** (deliberate hard bar top-3 ✅; live-tier soft check also
>   top-3), user-B isolation returned **0** snippets, and every embeddings row carried
>   `model=voyage-4 dims=1024` (versioning bar). The run rode Voyage's free-tier rate limiter via the
>   adapter's 429 backoff (background tier only; query embeds stay fail-fast per adr-0005 §8).
> - **25 (auto-index freshness)** — ✅ the marker-and-sweep indexer makes a finished call queryable
>   **~0.7s after `ended_at` vs the <60s** exit bar, proven end to end through the REAL sweeper + REAL
>   pgvector store in `rag.freshness.integration.test.ts` (idempotent re-sweep + empty-transcript edge
>   covered). **†** that proof uses a deterministic MOCK embedder (no vendor key); live-embedding
>   retrieval QUALITY on the indexed chunks is row 24's key-gated gate. Separately, the store-level
>   **latency exit bar** passes: `scripts/bench-rag.ts` (`npm run bench:rag`) measured **p50 5.2ms /
>   p95 7.2ms / max 9.6ms vs the <300ms** bar over a 40k-chunk corpus (10k for one user + 30k noise),
>   no vendor key needed.

## Explicitly OUT of scope (decided, not forgotten)

- Desktop overlay / screen-share stealth — desktop-only concept, contrary to Nova's model
- Screenshot/vision "read my screen" answers — desktop feature; revisit post-MVP
- BYO API keys — Nova is company-keys + subscription by design
- Local/offline models on device — cloud-first; revisit if privacy tier demanded
- Voice output / TTS — Nova is a silent text copilot
- Auto-SENDING follow-up emails — we draft, user sends (trust + deliverability)
