# Design — Usage metering, quotas, billing hooks (`modules/metering`)

> Phase 6 build spec (LOOP_PLAYBOOK Phase 6, PARITY rows 32–33, 35). Why-decisions in
> `DECISIONS/adr-0007-metering.md`. This phase GATES external TestFlight: no outside
> testers until the kill-switch test passes. Vendor set note: Anthropic is DISABLED
> by decision (2026-07-22, cost) — code kept, key removed; the metering layer still
> prices it so re-enabling is a key-paste, not a code change.

## What it does

Every expensive operation — LLM tokens (live + notes + follow-up), STT audio seconds,
Voyage embedding/rerank tokens — lands as a `usage_events` row attributed to a user
(and meeting where known) with a config-priced cost estimate. Plan-based quotas refuse
work past the limit with a typed error the app can render as a paywall; per-user rate
limits and a one-live-call-per-user cap protect the server; a global daily spend cap
is the kill-switch that stops NEW spend while letting in-flight work finish. A
RevenueCat webhook (fixture-tested; live wiring is a Phase 8+ mobile concern) maps
purchases to `profiles.plan`.

## Module anatomy (`apps/server/src/modules/metering/`)

- `ports.ts` — `UsageKind` (`'llm_tokens' | 'stt_seconds' | 'embedding_tokens' |
  'rerank_requests'`), `UsageEventInput` zod, `UsageEventsDb` port (insert +
  period-sum + daily-global-sum), `MeteringService` interface.
- `service.ts` — `createMeteringService(deps)`: `record(input)` (fire-and-forget
  posture: a metering INSERT failure logs at error level and never fails the metered
  operation — but see the audit invariant below), `meterFor(userId, meetingId?)`
  → a llm `Meter` closure stamping attribution, `spendToday()`, `usedInPeriod(userId,
  kind, periodStart)`.
- `pricing.ts` — the config-driven price book (zod, defaulted): per llm model
  $/1M input + $/1M output (openai, google, groq, anthropic-kept-priced), STT
  $/audio-hour per vendor, Voyage $/1M tokens, rerank $/1k requests. Unknown
  model/vendor → cost 0 + one warn log (never blocks; estimates are advisory,
  quotas/caps run on AMOUNTS and estimated dollars respectively).
- `config.ts` — plan limits + caps: `plans.free` / `plans.pro` (stt seconds per
  30-day period; llm tokens per period), `dailyGlobalCapUsd` (default 50),
  `quotaRecheckSeconds` (default 15 — mid-stream cadence), all zod `.default()`ed,
  injectable.
- DB adapter in `apps/server/src/db/usage-events.ts` (house seam style; supabase-js
  or pool — implementer picks to match query needs, explicit columns).

## Data model (one expand migration)

`usage_events` — append-only ledger:
- `id uuid pk`, `user_id uuid fk profiles NO ACTION`, `meeting_id uuid null fk
  meetings NO ACTION`
- `vendor text` (e.g. 'openai','google','assemblyai','deepgram','voyage')
- `kind text check in ('llm_tokens','stt_seconds','embedding_tokens','rerank_requests')`
- `amount numeric not null` (tokens / seconds / requests — unit implied by kind)
- `input_amount numeric null`, `output_amount numeric null` (llm split, null otherwise)
- `model text null`, `cost_estimate_usd numeric not null default 0`
- `created_at timestamptz default now()`; NO soft-delete (append-only billing ledger —
  purge-worker order note: usage_events purge BEFORE meetings/profiles)
- RLS: `usage_events_select_own` for authenticated (users may read their own bar
  tab); ZERO write policies (service-role only writes). Grants match.
- Indexes: `(user_id, created_at)` for period sums; `(created_at)` for the global
  daily sum.

`profiles` expand: `plan text not null default 'free' check (plan in ('free','pro'))`.

## Wire-through (the audit invariant)

**Invariant (RULES §6): no code path reaches a vendor adapter without a metering
sink.** Enforced two ways: a STATIC audit test (grep-style, like the STT `[no-disk]`
audit) that every adapter/router construction site in `app.ts` wiring passes a real
meter/sink, and the E2E accuracy bar (fixture call → events within 5%).

- **LLM** — the existing `Meter` port already carries `{provider, model, tokens}`.
  Phase 6 extends the llm surface minimally: `LlmRouter.stream(req, signal, opts?:
  {meter?: Meter})` — an optional PER-CALL meter that overrides the constructed
  default (backward-compatible; router still meters exactly-once at `done`). Callers
  with user context (notes handler per job, follow-up per request, Phase 7 live) pass
  `metering.meterFor(userId, meetingId)`. This closes the Phase 5
  `JobUsage.provider` opener at the metering layer — provider attribution lands in
  `usage_events`, `jobs.usage` stays as-is.
- **STT** — the live session already owns the frame path (16kHz mono PCM16: bytes /
  32000 = seconds). It accumulates relayed-audio seconds and records `stt_seconds`
  attributed to the CURRENT vendor: an event is flushed on vendor switch, on
  disposal, and at each mid-stream quota recheck tick (so a crash loses at most one
  tick of attribution). Vendor-reported duration, where a vendor supplies it, is
  logged for the ±5% comparison but the frame count is the billed amount.
- **Voyage** — the adapter's `logUsage` callback feeds `record({kind:
  'embedding_tokens'|'rerank_requests'})`. The `Reranker` port gains the userId it
  has been missing (rag-internal signature change, closes that opener).

## Enforcement points

- **Quota (per-user, per-plan)** — checked at LIVE SESSION START (sum of period
  `stt_seconds` vs plan) and MID-STREAM every `quotaRecheckSeconds` of metered audio;
  exceeded → typed `quota_exceeded` wire error + policy close (the app's paywall
  state), in-flight LLM/notes work finishes. Notes jobs check llm-token quota at
  claim time (over → job completes with fallback notes? NO — job is REFUSED back to
  dead with `quota_exceeded`; regenerate after upgrade re-enqueues). Follow-up
  endpoint → 429-style typed `quota_exceeded` response.
- **Rate limit** — `@fastify/rate-limit` per-user (key = authenticated user id, IP
  fallback pre-auth) on the REST surface; the live WS is excluded (it has the
  concurrency cap). 100-rapid-request bar.
- **Concurrency** — ONE live session per user: in-memory registry behind a port
  (multi-instance claim = logged opener), second `session.start` → typed
  `concurrent_session` error + close.
- **Kill-switch** — `spendToday() >= dailyGlobalCapUsd` refuses NEW live sessions and
  NEW notes-job claims (typed `daily_cap_reached`), in-flight finishes; crossing the
  cap fires ONE error-level alert log per day (`metering.daily_cap_tripped` — the
  alert seam; real paging is ops-later).

## RevenueCat webhook

`POST /webhooks/revenuecat` — registered only when `REVENUECAT_WEBHOOK_TOKEN` is set;
`Authorization: Bearer <token>` checked first (401 otherwise). Body zod-parsed
(event envelope: `app_user_id` = Supabase user id — the mobile app sets this at SDK
init, Phase 8 — `type` INITIAL_PURCHASE/RENEWAL/UNCANCELLATION → pro;
CANCELLATION+EXPIRATION/EXPIRATION → free; product→plan map in config). Applies
`profiles.plan` idempotently, 200 `{applied: true|false}`. Fixture webhook test
upgrades a test user (PARITY row 32's billing half; no live RevenueCat account
needed this phase).

## Verification map (playbook VERIFY BY → tests)

| Bar | Test |
|---|---|
| Metering ±5% | E2E fixture: scripted live session (mock vendors w/ known audio len) + notes job (mock router w/ known usage) → usage_events amounts within 5% of ground truth; llm exact (vendor-reported), stt vs fixture duration |
| Quota | test user on a 60-second cap plays >60s fixture audio → mid-stream `quota_exceeded` + close; second session refused at start; paywall state = the typed wire error asserted |
| Rate limit | 100 rapid authed requests → 429s begin, server healthy after |
| Concurrency | same user 2 simultaneous `session.start` → second refused typed |
| Kill-switch | seeded usage_events past the daily cap → new session + new job claim refused, in-flight mock call finishes, alert log asserted once |
| Audit | static: adapter construction sites all pass a sink; runtime: no vendor call path with noopMeter in production wiring |
| RevenueCat | fixture INITIAL_PURCHASE upgrades user free→pro; bad token 401; malformed body 400 |
