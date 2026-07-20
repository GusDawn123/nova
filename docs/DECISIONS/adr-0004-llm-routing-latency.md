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

## Known gaps (logged Phase 3+ openers)
- Post-commit failures don't feed the circuit breaker (one-token-then-die vendor
  wins every race). Top priority before real traffic.
- 400/404 classified transient (burns a failover sweep); needs an "invalid" class.
- All-benched exhaustion yields an empty failures summary (observability).
