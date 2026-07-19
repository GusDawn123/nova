# Nova

**Your AI copilot for real conversations.** Nova listens during phone calls, meetings,
and in-person conversations (with consent), live-transcribes who said what, whispers
context-aware suggestions while you talk, and hands you structured notes + a ready
follow-up draft the moment you hang up — grounded in everything you've taught it about
your life and work.

> Status: **pre-scaffold** — governance and architecture are designed; code begins at
> Phase 0 of the loop playbook.

## Start here (humans and AI agents)

1. **`docs/ARCHITECTURE.md`** — what Nova is and how it's shaped
2. **`docs/RULES.md`** — the engineering constitution (binding)
3. **`docs/LOOP_PLAYBOOK.md`** — the phased, self-verifying build plan
4. **`docs/GIT_WORKFLOW.md`** — branches, environments, deploy guards
5. **`docs/PARITY.md`** — feature checklist: what done looks like
6. **`CLAUDE.md`** — AI-agent working guide

## Monorepo layout

```
apps/mobile      React Native + Expo app (thin client)
apps/server      Node/TS engine: STT gateway, LLM router, RAG, notes, metering
packages/shared  zod schemas + types shared by both
supabase/        Postgres migrations (RLS, pgvector)
scripts/         backfills, seeds, purge
docs/            living documentation — updated in the same PR as the change
```

## Principles in one breath

Thin phone, smart server. Parse every boundary. Soft delete always. Vendors behind
adapters. Migrations expand→backfill→contract. Every user isolated by RLS, proven in CI.
Every paid API call metered. Docs live with the code. Verification before "done."
