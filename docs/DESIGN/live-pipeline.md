# Nova Live Pipeline — Design (Phases 3–5, 7)

Status: accepted 2026-07-20 (designed with Gustavo in conversation; clean-room — derived
from public latency/streaming patterns, tailored to mobile). This is the build spec the
phase loops implement. Companion decisions: `DECISIONS/adr-0004-llm-routing-latency.md`.

## Shape: phone-dumb / server-brain

The phone captures audio and renders events; **all intelligence lives in the server**.
One persistent **authenticated WebSocket per call**: audio frames up, a typed event
stream down. The socket opens at call start so the handshake/TLS/auth cost is paid
off the hot path. Heartbeat + reconnect-with-resume (session id survives a drop).

```
mic (16kHz PCM, 40–80ms frames)
  └─ WS ──► modules/stt (AssemblyAI primary / Deepgram fallback, pre-warmed, interims)
              └─► rolling transcript ──► modules/live (conductor)
                        │  trigger gate (tiered, cheapest first, off the LLM path)
                        │  speculation manager (fire on confident partial,
                        │    similarity-reconcile on final, adopt-or-discard)
                        │  deadline ladder (active abort via the llm router)
                        └─► modules/llm (latencyTier: "live" → reasoning OFF,
                              serial cascade cheapest/fastest first)
                                  └─► suggestion.start/delta/done/discard ──► WS ──► phone
```

## Server modules

### modules/stt (Phase 3 — this phase)
- Accepts the audio stream over the authed WS; **relays** to the vendor's streaming
  socket; emits zod-validated transcript events `{ text, isFinal, speaker, ts }` with
  diarization from the single mixed mic feed.
- AssemblyAI primary, Deepgram fallback, both behind `adapters/` (RULES §5). Vendor
  sockets **pre-warmed** at session start; interim results ON; endpointing tuned for
  conversation (~300ms).
- Failover = active abort + `provider_switched` event; vendor reconnect with backoff
  is invisible to the client socket. Raw audio is **never written to disk** (RULES §3).

### modules/prompt (built when prompts land — Phases 5/7)
- Prompts are **authored content files**, word-for-word from
  `docs/prompts/nova-prompts-source.md` (Gustavo's text; never paraphrased) — plus his
  separately authored Sales prompts. Code assembles, code never writes prose.
- One pure `assemble(mode, context) → { stablePrefix, dynamicSuffix }`.
  - **stablePrefix**: the full monolithic system prompt (identity, security,
    decision hierarchy, transcript rules, format rules, question-type handling,
    mode body). Byte-stable across turns — **enforced by a snapshot test** so the
    vendor prompt cache can't silently churn.
  - **dynamicSuffix**: the only uncached tokens — windowed transcript slice,
    RAG snippets under a hard token budget, user-provided context (hard-guarded:
    can never override identity/safety).
- Per-vendor cache warmed in **background at call start**; a cache miss proceeds
  uncached, never blocks first token.
- Deterministic post-passes ONLY for security/identity guards and incremental-safe
  stream cleanups (strip markdown headers, escape `$`); cosmetic format rules ride
  on prompt directives (decision 2026-07-20).

### modules/live (Phase 7 — the conductor)
- **Trigger gate**, tiered cheapest-first and off the LLM hot path: the fastest call
  is the one never made. Quiet in small-talk windows (spam = uninstall driver).
- **Speculation manager**: fire on a confident partial; on the final utterance,
  similarity-reconcile (Jaccard-style) — adopt the in-flight answer or discard it
  (client gets `suggestion.discard`, never a zombie card).
- **Deadline ladder**: per-stage budgets with **active abort** through the router.
- **Context budget caps**: RAG/history can shrink, never delay, the first token.

### modules/llm (built Phase 2; extended later)
- Add `latencyTier: "live" | "deliberate"`. Live tier: reasoning/thinking OFF
  (single biggest TTFT lever), serial cascade cheapest/fastest-first, per-model
  config (see adr-0004). Deliberate tier (notes pipeline): quality-first order,
  reasoning allowed.

## Wire protocol (packages/shared, Phase 3 starts it)
Zod discriminated union, versioned:
- up: `audio.frame` (16kHz PCM, 40–80ms), `session.start/end`, `ping`
- down: `transcript.partial`, `transcript.final`, `suggestion.start/delta/done/discard`,
  `provider_switched`, `error`, `pong`
- Server **coalesces tokens ~50ms/batch** (radio wakeups cost battery; per-token
  frames are a phone anti-pattern).
- Transport MUST close/return the router and vendor streams on client disconnect —
  phones drop constantly; an abandoned stream is a money leak.

## Mobile (Phase 7/8)
- `use-live-session` hook owns the socket; screens stay dumb (RULES §10).
- **Frame-cadence rendering**: deltas append to a ref buffer; one throttled flush
  per frame; plain text while streaming; single format upgrade on `done`.
- One `SuggestionCard` component, variants by `kind`.

## Latency is a tested contract
Budgets live in config and are enforced by fake-timer tests like the Phase 2 router
suite, plus stage-timing benchmarks that print p50/p95:
- final utterance → suggestion visible: **p50 < 1.5s**
- speculation hit → visible: **p50 < 500ms**
- playbook Phase 7 gate: question moment → first token p50 < 2s, p95 < 4s.
Speed is provable, not promised.
