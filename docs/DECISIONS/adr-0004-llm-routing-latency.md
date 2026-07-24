# ADR-0004 — LLM routing, latency tiers, and prompt-cache strategy

Status: accepted 2026-07-20. Context: Phase 2 built `modules/llm` (streaming failover
router, 27 pinned behavior tests); the live-pipeline design (docs/DESIGN/live-pipeline.md)
consumes it. This ADR records the routing/latency decisions made during and after Phase 2.

## Decisions

1. **Sequential cascade, not hedged racing.** The router tries one provider at a time
   (TTFT race → silent failover) rather than fanning the same request to several
   vendors and taking the fastest. Rationale: the live rung is a cheap/fast model with
   reasoning off (~0.5s TTFT observed class of model) — hedging would multiply spend
   for marginal p95 gains at our scale. Revisit only with p95 data that says otherwise.

2. **First-token commit.** After the first non-empty token, never switch providers —
   a post-commit failure ends the stream gracefully. Mixed-voice output is worse than
   a truncated stream. (Pinned by [commit] tests.)

3. **SDK-internal retries OFF** (`maxRetries: 0` on every adapter client). Retry policy
   belongs to the router (breaker, auth bench, failover); hidden vendor-SDK retries
   stacking under router failover multiplies tail latency and spend.

4. **Latency tiers.** `latencyTier: "live" | "deliberate"` (extension, pre-Phase 7):
   - `live`: reasoning/thinking OFF (the single biggest TTFT lever), serial cascade
     cheapest/fastest first, tight ttft/stall budgets, deadline-ladder active abort.
   - `deliberate` (notes pipeline): quality-first order, reasoning allowed, relaxed
     budgets.

5. **Model policy is config, not code** (Gustavo's product decision, env-tunable):
   live cascade cheapest/fastest first — Gemini Flash-Lite (thinking off) → Groq
   Llama → OpenAI mini-class (low reasoning effort) → Anthropic. Deliberate order
   favors quality. Exact model IDs live in env/config so swaps never touch code.

6. **Prompt-cache strategy: one monolithic cached system prompt.** The full system
   prompt (identity, security, format, question-type handling, mode body) is a single
   byte-stable **cached prefix** (snapshot-test enforced). Cached tokens prefill ~an
   order of magnitude cheaper/faster than fresh tokens, so moving per-turn
   "answer-type" blocks out of the prefix into the (never-cached) dynamic suffix
   would make TTFT worse, not better. Answer-type selection may be added **later as
   a cost optimization only**, driven by measured spend — never as a speed play.
   The real prompt-side latency lever is keeping the **dynamic suffix small**
   (windowed transcript slice, hard RAG token budget).

7. **Deterministic post-passes are for guarantees, not cosmetics.** Output post-
   processing is limited to security/identity guards (may buffer a segment) and
   incremental-safe stream cleanups (header strip, `$` escaping). Cosmetic format
   rules (headline length, bullet counts) ride on prompt directives; occasional
   misses are accepted rather than paying buffering/flicker on the live path.

8. **`req.model` is a metering label**, not forwarded to vendors — each adapter owns
   its model ID. Prevents cross-vendor model-name confusion. (Phase 2 ruling.)

## Implementation status (Phase 7, `dev-claude-live-copilot`)

- **Live tier — SHIPPED.** `chatRequest.latencyTier: "live" | "deliberate"` (ports.ts);
  the router selects the cheapest-first `liveOrder`
  (google→groq→openai→anthropic) for a live request unless `providerOrder` overrides
  (config.ts, router.ts). `liveLlmConfig()` carries the tight TTFT (1500ms) / stall
  (8000ms) budgets. Decision 4's "reasoning OFF" is satisfied at the ADAPTER layer
  (Gemini `thinkingBudget:0`; the OpenAI mini / Groq 8b models have none), so there is
  no per-call reasoning toggle — a deliberate simplification (revisit only if a live
  cascade model gains default reasoning). Order selection pinned by `router.tier.test.ts`.
- **Monolithic cached prefix (decision 6) — SHIPPED** as `modules/prompt`: the byte-stable
  `stablePrefix` (sha256-pinned by `assemble.snapshot.test.ts`) + the small uncached
  `dynamicSuffix` (windowed transcript + hard-budgeted RAG snippets + hard-guarded user
  context). Answer-type selection is NOT split out (decision 6 keeps it in the cached
  prefix until measured spend says otherwise).
- **Deterministic post-passes (decision 7) — DEFERRED on the live path.** The conductor
  streams tokens raw; cosmetic format rules ride on the prompt directives (the prompt's
  "NO headers" etc.), accepting occasional misses over live buffering/flicker — exactly
  decision 7's posture. Incremental-safe header-strip / `$`-escape passes remain a future
  add if live output quality demands them.

## Addendum — 2026-07-23 model refresh (decision 5 in action)

Default model swaps (config/adapter-level only — the router is untouched, exactly as
decision 5 intends):
- **openai: `gpt-4o-mini` → `gpt-5.4-mini`** ($0.75/$4.50 per 1M, verified on OpenAI's
  pricing page at swap time; the price book moved in lockstep). gpt-5.x minis are
  reasoning-capable, so the shared OpenAI-compatible engine gained an optional
  `reasoningEffort` knob and the openai adapter pins **`reasoning_effort: "none"`** —
  probed live: the model REJECTS `'minimal'` (400; accepts none/low/medium/high/xhigh)
  and `"none"` yields `reasoning_tokens: 0`. Groq passes no knob (its llama endpoint has
  no such param).
- **google: `gemini-2.5-flash` → `gemini-3.5-flash-lite`** ($0.30/$2.50 per 1M). Probed
  live: the LITE model **rejects any `thinkingConfig`** (400 INVALID_ARGUMENT for both
  `thinkingBudget: 0` and `thinkingLevel`) — the lite lineage is non-thinking BY
  DEFAULT, so the adapter now OMITS the knob; omission IS the off state. If the default
  ever returns to a thinking-by-default variant, the knob must come back
  (model-conditional).
- Groq (`llama-3.1-8b-instant`) and Anthropic (disabled; `claude-haiku-4-5`) unchanged;
  `liveOrder`/`defaultOrder` unchanged.
- These defaults also serve the DELIBERATE tier (notes pipeline) — the key-gated
  `notes.accuracy.test.ts` re-runs on the new models (see the Phase 7 gate runs).
- Old price-book ids are DROPPED: costs stamp at write time, so historical
  `usage_events` rows keep the rate they were written with.

## Known gaps (logged Phase 3+ openers)
- Post-commit failures don't feed the circuit breaker (one-token-then-die vendor
  wins every race). Top priority before real traffic.
- ~~400/404 classified transient (burns a failover sweep); needs an "invalid" class.~~
  **CLOSED (Phase 6):** `classifyHttpStatus` is now three-way — 401/403 `auth`
  (bench, unchanged), **400/404/422 `invalid`** (immediate failover, no
  same-provider retry, DOES count toward the breaker so repeated invalids trip it
  open), rest `transient`. Live evidence: the 2026-07-22 anthropic credit outage
  returned 400s the router classed transient, burning a failover sweep per call.
- All-benched exhaustion yields an empty failures summary (observability).
