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
| 1 | Live transcription during a conversation (interim + final results) | 3 | fixture WAV streaming test | ⬜ |
| 2 | Speaker separation — who said what (diarization from single mic feed) | 3 | 2-speaker fixture, turn-boundary assert | ⬜ |
| 3 | Works for in-person conversations (mic acoustic capture) | 3 + 9 | noisy-fixture bar + physical-device E2E | ⬜ |
| 4 | Works for phone/VoIP calls via speakerphone | 9 | physical-device E2E checklist | ⬜ |
| 5 | STT provider failover (vendor outage invisible to user) | 3 | dead-endpoint failover test | ⬜ |
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

> **Row 11 — Phase 2 (branch `dev-claude-llm`, commits `c172b74..645e32f`, PR pending):**
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
> `claude-haiku-4-5` / `gpt-4o-mini` / `gemini-2.0-flash` / `llama-3.1-8b-instant` unverified
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
| 24 | Per-user context library ("your life": docs, profile, notes) | 4 | seed + top-3 retrieval test | ⬜ |
| 25 | Past calls auto-indexed into memory | 4 | freshness test (<60s) | ⬜ |
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
| 34 | Transcript-only storage (no audio persisted) | 3 | code-audit + storage assert in E2E | ⬜ |
| 35 | Global spend kill-switch | 6 | kill-switch test — TestFlight gate | ⬜ |

> **Rows 29–31 — Phase 1 (branch `dev-claude-auth`, commits `ba2e1ea..3ed3c6e`, PR pending):**
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

## Explicitly OUT of scope (decided, not forgotten)

- Desktop overlay / screen-share stealth — desktop-only concept, contrary to Nova's model
- Screenshot/vision "read my screen" answers — desktop feature; revisit post-MVP
- BYO API keys — Nova is company-keys + subscription by design
- Local/offline models on device — cloud-first; revisit if privacy tier demanded
- Voice output / TTS — Nova is a silent text copilot
- Auto-SENDING follow-up emails — we draft, user sends (trust + deliverability)
