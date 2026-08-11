# The prompt library

One always-on system prompt, one file per mode, and categories that are not modes.

## How it composes

```text
SYSTEM_PROMPT          general rules — always on, whatever the user picked
        +
MODES[picked]          that domain's directive + answer structure + its examples
        +
context                user memory, RAG snippets, transcript window (last)
```

The user picks the mode on the front end. There is no domain classifier and no
priority ladder — the mode arrives as an input on `session.start`. That removes
three failure modes at once: misclassification, a latency hop before every
answer, and any ambiguity about why an answer came out the way it did. What the
system prompt still does is read the MOMENT within the picked domain: answer a
question, offer follow-ups when there is no question, meet an objection — that
moment-level judgment lives in `system.ts`, not in code.

## What is here

| File | What it is |
|---|---|
| `system.ts` | The default system prompt. Domain-neutral rules only. |
| `modes/behavioral.ts` | Extracted from the source, intact — the only mode it demonstrated end to end. |
| `modes/technical.ts` | Thin in the source (4 bullets, no example). Structure and example added. |
| `modes/finance.ts` | Thin in the source (6 bullets, no example). Structure and example added. |
| `types.ts` | The shape every piece shares. |

## What is deliberately not here

**Sales and negotiation.** Deferred. Their raw material — `conversation_advancement_priority`
and `objection_handling_priority` — went into `system.ts` instead, because knowing
when to offer a follow-up question and how to name an objection are useful in every
domain, not only in a sales call.

**Creative.** Present in the source (`nova-prompts-source.md` 251-271) and not built.
It is a one-line directive — "complete answer + 1-2 rationale bullets" — with a
"what's your favorite animal and why" example. It exists to stop the model
freezing on questions that have no correct answer, where the reasoning IS the
answer. That is an interview-screening situation; on Nova's calls it has no
obvious home yet.

**Screen problem solving.** Removed entirely, along with the source's opening claim
that Nova can see the user's screen. Nova has no screen capture and never attaches
a screenshot, so that sentence told the model it had an input it would never get.

**The priority ladder.** The source's six rungs existed to decide which kind of
help the moment needed. The user picking the mode answers that question directly,
so there is nothing left to arbitrate.

## Where the pieces belong

Few-shot examples ship **with their mode**, never in `system.ts`. The system prompt
is the cacheable byte-stable prefix in `assemble()`; anything that varies per call
costs a cache miss if it lives there. A transcript sample in the prefix is paid for
on every call in every mode.

## Status

**Wired** (2026-08-01). `assemble(mode, context)` builds every live `stablePrefix`
from here: `SYSTEM_PROMPT` always, plus the picked mode's block. The mode arrives
on `session.start` as a `liveModeSchema` value — `general | behavioral | technical
| finance`, where `general` is the system prompt alone — and is locked for the
session, so each mode keeps its own byte-stable prefix and its own warm vendor
cache. `library.test.ts` proves the keys here match that enum minus `general`, so
a mode cannot exist on one side and not the other.

The flattened `content/system-prompt.ts` and its generator `scripts/gen-live-prompt.mjs`
are **legacy and unwired**. Both stay on disk, banner-marked, as the reference for
what the single monolithic prompt said; nothing on the live path imports them.

**The live gates have not been re-run against this text.** The relevance,
grounding and quiet gates that are green in `CLAUDE.md` were measured on the
legacy prompt. Re-running them is a key-gated, paid job and the next thing to do
with this library.
