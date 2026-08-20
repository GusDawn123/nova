---
name: designing-prompt-stacks
description: Use when designing or refactoring the system-prompt layer of an LLM product with more than one persona/mode, output type, or model provider (a copilot, assistant, or agent), or when symptoms appear such as duplicated prompt constants drifting apart, prompts too long to cache, a rule stated mid-prompt being ignored, a silence/no-op sentinel leaking into real answers, spoken or read-aloud output sounding robotic, or a big-bang prompt rewrite with no rollback path.
---

# Designing Prompt Stacks

## Overview

A system prompt for a multi-mode, multi-action product is not a string — it is a **composition** of small ordered blocks, assembled per request from independent axes, wrapped by deterministic code on both sides of the model call. Prompts written as finished constants (one per mode × action × provider) drift, bloat, and defeat caching; a composer with a fixed block order does not.

## When to Use

- Building a copilot/assistant with several **modes** (sales, interview, lecture, support…) and several **actions** (answer, recap, clarify, title…)
- Adding a second or third **model provider** and tempted to fork the prompt per provider
- Prompt constants have multiplied (`MODE_X_PROMPT`, `PROVIDER_Y_PROMPT`…) and a fix must be copied into each
- A rule near the top of a long prompt is being ignored later in the output
- Output is **spoken aloud / read as the user's own words** and sounds like an AI wrote it
- A "stay silent" sentinel shows up on turns the user explicitly triggered
- Planning a prompt rewrite and need to ship it without betting the product on it

**Not for:** a single-purpose prompt with one mode and one output shape; one-off prompts in scripts; prompt *content* (what to say) — this skill is about prompt *structure*.

## Core Pattern

```ts
// BEFORE — finished constants, one per combination (drifts, duplicates, uncacheable)
export const SALES_ANSWER_PROMPT   = `${CORE}\n${RULES}\n...sales voice...answer shape...`;
export const SALES_RECAP_PROMPT    = `${CORE}\n${RULES}\n...sales voice...recap shape...`;
export const LECTURE_ANSWER_PROMPT = `${CORE}\n${RULES}\n...lecture voice...answer shape...`;
export const PROVIDER_B_SALES_ANSWER_PROMPT = `${CORE}\n...same thing, slightly different...`;

// AFTER — one composer, axes as inputs, order fixed
buildSystemPrompt({ mode: 'sales', action: 'recap', tier: 'cloud' })
// = CORE(tier) + MODES.sales + ACTIONS.recap + silenceGate(action)
//   + voiceContract(mode, action) + [optional contracts] + custom(escaped) + FINAL_CHECK
buildTurnContent({ evidence, recentTranscript, currentTurn, task })
// = <evidence_set> → <recent_transcript> → <current_turn> → <task>   (ask LAST)
```

## Quick Reference

**Three axes per request**

| Axis | Question it answers | Cardinality | Lives in |
|---|---|---|---|
| MODE | who is speaking / the setting | ~8 + custom | `MODES[mode]` lookup |
| ACTION | what shape comes out | ~12 | `ACTIONS[action]` lookup |
| TURN CONTENT | what is known right now | per turn | the user message envelope |

**System prompt — nine blocks, this order**

| # | Block | Varies by | Why here |
|---|---|---|---|
| 1 | Core (identity, security, grounding laws) | tier (cloud/local) | stable → cacheable prefix |
| 2 | Mode | mode | who speaks |
| 3 | Action | action | output shape |
| 4 | Silence gate | action | may it emit the no-op sentinel? (code lookup) |
| 5 | Voice contract | mode × action | "mode sets who, action sets what, neither erases the other" |
| 6 | Coding contract | only coding turns | validator-checkable fixed sections |
| 7 | Read-surface layout | only typed chat | lists allowed when nobody speaks it |
| 8 | Custom instructions | user config | escaped, capped (~1,200 chars) |
| 9 | **Final check** | tier | **always last** — recency; can't be overridden by #8 |

**Turn envelope — four sections**: `evidence_set` (ranked, escaped) → `recent_transcript` → `current_turn` → `task` (last).

## The Design Rules

1. **Independent axes.** Mode and action are inputs; write N + M blocks, never N × M prompts.
2. **Stable prefix, volatile suffix.** Everything that is identical across a session goes in the system prompt (provider-cacheable); everything that changes goes in the turn envelope.
3. **Hard rules at the recency position.** Restate the non-negotiables in a final block *after* user-supplied instructions. A rule placed early in a long prompt gets skipped by the time the model is generating; the same rule restated at the end holds.
4. **Escape and cap anything untrusted.** Documents, transcripts, and custom instructions are XML-escaped so they cannot close a trusted tag; custom text has a length cap.
5. **Boundaries are lookup tables, not prose.** "May this action stay silent?" is a `Set` checked in code, not a paragraph the model interprets.
6. **Deterministic pre-pass decides, the model writes, deterministic post-pass enforces.** Routing, evidence selection, and format are chosen in code first; voice/length/format are enforced in code after.
7. **Spoken and read surfaces get different shape contracts.** Read-aloud text bans dashes, semicolons, lists, headers; a typed panel may use structure. Same facts, different contract.
8. **Provider-neutral core; provider quirks in adapters.** No `PROVIDER_X_*` prompt forks — tag syntax, token limits, caching live in the adapter.
9. **Migrate behind a flag with a byte-identical fallback.** Every call site is `newComposer(...) ?? legacyConstant`; kill-switch restores the old path exactly.
10. **Measure with paired A/B and a blind judge — and commit the artifacts.** Numbers in a commit message are not evidence a year later.
11. **Keep the flag default next to its comment.** A comment saying "default OFF" eight screens above `default: true` is how docs rot.

## Common Mistakes

| Mistake | What happens | Fix |
|---|---|---|
| Baking mode × action × provider into constants | a security fix lands in 3 of 5 copies | composer with axes as inputs (Rule 1, 8) |
| Shared prefix shipped twice when a mode is active | ~2k wasted tokens per request; a `startsWith` strip-hack appears | one composition, prefix emitted once (Rule 2) |
| Hard rule only in the core block | ignored once the prompt is long | final-check block last (Rule 3) |
| Custom instructions after the final check | user text overrides the laws | custom before final check (Rule 3) |
| Silence rule written as prose | no-op sentinel emitted on explicit requests, judged "no assistance" | per-action allow-set (Rule 5) |
| Re-escaping already-sanitized context | upstream structure corrupted | escape at exactly one boundary; pass assembled blocks verbatim |
| Same voice contract for spoken and typed output | bullet lists read aloud / flowing prose nobody can scan | surface flag picks the layout block (Rule 7) |
| Deleting the migration notes after cutover | nobody can reconstruct why V2 exists | keep the doc; link the benchmark artifacts (Rule 10) |

## Real-World Impact

In a production live-meeting copilot codebase, replacing ~45 finished prompt constants with a nine-block composer was measured over 9 runs × 600 paired prompts with a blind LLM judge: the composer won 29 of 32 scoring categories, roughly 2:1 on per-pair wins (310 wins / 155 losses / 103 ties), judge total 18.87 vs 16.51, and cut heavy live-route prompts by 49–87 % (one 47k-char prompt became 7.5k). One surface grew +7 % — accepted so every surface carries the same security block. The composer was cut over as default-ON with a one-env-var kill-switch.

## Reference files

- `reference/composer-pattern.md` — the full block stack, turn envelope, and an original TypeScript composer
- `reference/voice-enforcement.md` — spoken-output contract and the deterministic post-model pass
- `reference/actions-and-silence.md` — action catalogue, trigger/silence/voice table, silence gate as lookup
- `reference/migration-playbook.md` — templates → composer migration, flag + `??` fallback, A/B + blind judge, pitfalls
