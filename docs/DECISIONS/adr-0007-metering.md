# ADR-0007 — Metering, quotas, and the spend kill-switch

- **Status:** accepted (Phase 6, 2026-07-22)
- **Context:** LOOP_PLAYBOOK Phase 6. Continuous STT + LLM on company-held keys is
  the business model's cost center; RULES §6 makes unmetered vendor calls illegal and
  spend caps sacred. Build spec: `DESIGN/metering.md`. Prior seams: llm `Meter` port
  (Phase 2), voyage `logUsage` sink (Phase 4), notes `jobs.usage` jsonb (Phase 5).
  Live evidence motivating the error-class work: the 2026-07-22 Anthropic credit
  outage returned 400s that the router classed transient, burning a failover sweep
  per call. Anthropic is now DISABLED (cost decision) but stays priced and coded.

## 1. One append-only `usage_events` ledger, config-priced at write time

A single table for all vendors/kinds (not per-vendor tables): billing queries are
cross-vendor by construction ("today's spend", "this user's period"). Amounts are the
source of truth (tokens/seconds/requests); `cost_estimate_usd` is stamped at write
time from a zod-defaulted price book — advisory, never blocking, unknown model → 0 +
warn (a missing price must not take down a call path). Append-only, NO soft-delete
(a billing ledger is history; RULES §3's soft-delete law is for user-managed data —
this deviation is this ADR's explicit exception, purge-worker handles deletion).
Users get `select_own` RLS (they may see their bar tab); writes are service-role only.

## 2. Per-call meter injection, not per-user router instances

The failover router's breaker/bench state must stay process-global (a per-user router
would reset circuit state and re-probe dead vendors per user). So user attribution
travels WITH THE CALL: `LlmRouter.stream(req, signal, opts?: {meter?: Meter})` — an
optional per-call meter overriding the constructed default; `metering.meterFor(
userId, meetingId?)` builds the closure. Exactly-once-at-`done` semantics unchanged.
Rejected: AsyncLocalStorage (implicit context is invisible in review and fragile
across queue/timer hops); meter-on-ChatRequest (functions don't belong in a
zod-parsed wire schema).

## 3. STT billed by relayed frames, cross-checked against vendors

The session counts relayed audio bytes (16kHz mono PCM16 → bytes/32000 = seconds) —
vendor-independent, survives failover mid-call, and matches what we PLAY to vendors.
Events flush on vendor switch / disposal / each quota-recheck tick (bounded loss on
crash: one tick). Vendor-reported durations, where available, are logged beside ours
for the ±5% accuracy bar but the frame count is authoritative (one metric to bill,
one to audit).

## 4. Quota = plan limits on AMOUNTS, enforced at start AND mid-stream

`profiles.plan` ('free'|'pro', default free) + zod plan limits (stt seconds and llm
tokens per rolling 30-day period). Live: checked at session start and every
`quotaRecheckSeconds` of metered audio → typed `quota_exceeded` + policy close (the
paywall state the app renders). Notes jobs: checked at claim; over-quota jobs
dead-letter with `quota_exceeded` (regenerate after upgrade re-enqueues; silently
producing fallback notes would hide the paywall). Quotas run on amounts, not
dollars — dollars are estimates, amounts are facts.

## 5. Kill-switch on estimated dollars, refuse-new / finish-in-flight

The global daily cap is exactly the thing estimates ARE for: an order-of-magnitude
circuit breaker (default $50/day, config). `spendToday()` gates NEW live sessions and
NEW job claims (typed `daily_cap_reached`); in-flight work completes (mid-call
kill = user-hostile, bounded by session lengths). One error-level alert log per trip
per day is the alert seam. Rejected: mid-stream global kill (punishes the user in
the middle of a sales call for other users' spend).

## 6. Rate limit via @fastify/rate-limit; concurrency via in-memory registry

REST: `@fastify/rate-limit`, per-authenticated-user key (IP pre-auth) — boring,
battle-tested, config-tunable. Live WS: excluded from rate limiting; instead ONE
live session per user via an in-memory registry behind a port (typed
`concurrent_session` on the second start). Multi-instance registry (shared claim) is
a logged opener alongside the RAG sweeper's — single-instance posture is already the
deployment law.

## 7. RevenueCat as fixture-tested seam, not a live integration

The webhook route (token-gated, zod-parsed envelope, idempotent plan apply) ships and
is proven with fixture events; the LIVE RevenueCat account, product catalog, and the
mobile SDK setting `app_user_id` are Phase 8+ items on Gustavo. Billing state lives
in `profiles.plan` only — no local receipt/subscription mirror until a real
integration forces one (YAGNI).

## Consequences / openers

- llm "invalid" error class (400/404 permanent, no failover-burn) folds into this
  phase's llm touch — the credit-outage evidence is fresh.
- Openers logged: multi-instance session registry + sweeper claiming; vendor-reported
  vs frame-count drift monitoring; per-user spend alerting (only global cap alerts
  now); Reranker userId lands here (rag port change).
- Phase 8 reads the typed `quota_exceeded` / `daily_cap_reached` wire errors as
  paywall/blocked states; Phase 9's device test exercises the full metered path.

## Amendments (Phase 6 build, 2026-07-22)

Appended during the phase that authored this ADR (pre-merge amendments, not history
rewrites). Each is a ruling made during implementation and ratified in review.

1. **Failure-posture triad: quota/cap checks FAIL OPEN; ownership FAILS CLOSED; the
   kill-switch is the backstop.** An internal failure of a quota or daily-cap check
   (plan read, usage sum, seam throw) logs at error level and ADMITS the call/job —
   quota protects SPEND, not tenancy, and a metering-DB blip must not refuse every
   call on the platform. The meeting-ownership guard on the same `session.start`
   path keeps its Phase 4 FAIL-CLOSED law (it protects tenant isolation — different
   stakes). Runaway aggregate spend under a broken quota path is still bounded by
   the daily kill-switch, whose own check also fails open but with a LOUD, distinct
   `metering.daily_cap_check_failed` log. Gate order in `session.start`, cheap/global
   before per-user DB work: concurrency → daily cap → ownership → quota.

2. **Pre-first-establish STT attribution = the configured lineup head.** The engine
   announces vendors only on a SWITCH (`provider_switched` fires when the NEXT vendor
   establishes), so bytes relayed before the first switch are billed to the lineup's
   first vendor. If vendor[0] never establishes and relaying started before failover,
   a brief span can be attributed to a vendor that never transcribed — bounded by the
   engine's failover threshold; the frame count stays the billed truth (§3). "unknown"
   appears only when metering is wired with zero configured vendors (dev edge).

3. **Rerank events bill amount = 1 per request** (priced by the $/1k-requests book
   rate). The vendor-reported rerank token count rides the structured usage LOG line
   only — it is not persisted on the ledger row. Advisory-cost nuance only; quotas
   have no rerank dimension.

4. **RevenueCat auth is a static bearer token — no HMAC.** RevenueCat's webhook
   supports only a fixed Authorization header (no request signing), so the token's
   secrecy IS the whole authentication guarantee (ops note: rotate it via the RC
   dashboard + env together; the route is absent entirely when the env var is unset).
   Comparison is constant-time (sha-256 both sides + timingSafeEqual).
