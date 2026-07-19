# ADR-0001 — Stack: TypeScript/Node + Supabase + React Native/Expo

**Date:** 2026-07-19 · **Status:** Accepted

## Context

Nova is a mobile AI call copilot: continuous streaming audio up, live transcripts and
LLM suggestions down, per-user RAG memory, company-held vendor keys, subscription
business model. Solo founder (new to dev) + AI agents doing the building. Candidate
server languages considered: TypeScript/Node, Go, Python, Rust, C++.

## Decision

- **Server: TypeScript/Node (Fastify).** One language across server, mobile, and shared
  schemas. First-class vendor SDKs (Anthropic/OpenAI/Google/Groq/AssemblyAI/Deepgram all
  ship TS-first). WebSocket streaming is native territory. Scale path is horizontal
  (more instances behind a load balancer), not language swap; hot paths can migrate to
  Go later if ever measured necessary.
- **Users/data: Supabase.** Postgres + RLS for enforced per-user isolation, pgvector for
  RAG (as an adapter behind ports — swappable), built-in auth (email/Apple/Google),
  real Postgres locally via Docker → total dev/prod parity for migrations.
- **Mobile: React Native + Expo.** One TS codebase → iOS + Android; Expo dev builds
  handle the native mic/audio module; EAS channels map to our environments.
- **STT: AssemblyAI (primary) + Deepgram Nova-3 (fallback)** — best 2026 realtime
  diarization + best noisy/far-field robustness respectively; multi-provider routing
  from day one. (Same vendor pair the market leader discloses as subprocessors.)

## Consequences

- ✅ Lowest cognitive load for the founder; largest AI-agent training corpus; fastest hiring pool later.
- ✅ Migration discipline (expand→backfill→contract) runs on identical Postgres in dev/CI/prod.
- ⚠️ Node is not the theoretical max for concurrent sockets — accepted; revisit with
  measurements, not vibes (RULES: performance claims need numbers).
- ⚠️ Expo dev-build (not Expo Go) required once the native audio module lands — accepted.

## Alternatives rejected

Go (second language, thinner AI SDKs), Python (weakest at high-concurrency realtime WS),
Rust/C++ (performance we don't need at 10x build cost — the reference desktop product
only used Rust for OS audio capture, a problem phones don't have).
