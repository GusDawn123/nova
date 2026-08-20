# Migration Playbook — from template constants to a composer, without betting the product

This is how a production live-meeting copilot codebase moved ~45 finished prompt constants (per mode, per action, per provider) to a single composer, measured it, and cut over — and where it went wrong. Use it when you already have the constants and need to get to the stack described in `composer-pattern.md`.

## 0. Recognize the V1 shape

```
  CORE_IDENTITY ─┬─► MODE_SALES_PROMPT      = CORE + CONTEXT_RULES + CODING_RULES + 120 lines of sales text
                 ├─► MODE_LECTURE_PROMPT    = CORE + …                           + 110 lines of lecture text
                 ├─► PROVIDER_A_SYSTEM      = CORE + shorter rules (small model)
                 ├─► PROVIDER_B_SYSTEM      = CORE + <task>-tag style
                 ├─► PROVIDER_C_SYSTEM      = CORE + …
                 ├─► PROVIDER_A_RECAP, PROVIDER_B_RECAP, PROVIDER_C_RECAP …
                 └─► CUSTOM_SYSTEM, CUSTOM_ANSWER, CUSTOM_FOLLOWUP …
```

Symptoms that confirm you are here:

- **Drift**: the security block was fixed in the main constant; two provider variants still carry the old text.
- **Double shipping**: when a mode is active, the shared prefix (identity + rules, ~2k tokens) is sent once as the system prompt and again inside the mode suffix. A `SHARED_PREFIX` constant exists whose only job is to let a `startsWith` check strip the duplicate — and the comment admits it silently fails if a template diverges by a byte.
- **No order control**: the only way to put a rule last is to paste it at the end of every template.
- **Size**: live prompts of 40–50k characters on the routes that need the fastest first token.

## 1. Inventory before writing

List every call site that selects a prompt constant. For each, record: surface (live spoken / typed chat / background job), mode source, action, provider, and whether some *other* system already overrides the prompt there (a grounding engine, a persona layer). You will find surfaces nobody remembered (title generation, the email writer, a phone-mirror path). Each becomes a row in the `??` wiring table below.

## 2. Write the composer beside the constants

Do **not** edit the constants. Add `promptComposer.ts` with `MODES`, `ACTIONS`, the gates, and `buildSystemPrompt()` / `buildTurnContent()` per `composer-pattern.md`. Port meaning, not text: each 120-line mode template becomes a 5–10-line mode block, because the shared rules now live once in the core and the shape rules live in the action.

Pin the composition with a **behaviour-scenario fixture**: for every (mode × action × tier × activation) the test renders the prompt and compares byte-for-byte to a stored snapshot. This is the regression net for every later prompt edit (one codebase pinned 216 spoken compositions this way).

## 3. Wire every call site as `v2 ?? legacy`

```ts
// one flag, read fresh on every call (no module-level cache — bundlers inline
// modules per consumer, and a cached value can't be reset across copies)
export function isComposerEnabled(): boolean {
  const env = process.env.APP_PROMPT_COMPOSER;          // '0' | '1' | undefined
  if (env !== undefined) return env === '1' || env === 'true';
  return settings.get('promptComposerEnabled') ?? true; // the default lives HERE, next to its comment
}

export function resolveComposedPrompt(input: ComposeInput): string | null {
  if (!isComposerEnabled()) return null;                 // null → caller falls back
  try { return buildSystemPrompt(input); }
  catch { return null; }                                  // never let the composer take down an answer
}

// at each call site:
const system = resolveComposedPrompt({ mode, action: 'answer', tier }) ?? LEGACY_ANSWER_PROMPT;
```

Properties this buys:

- **Byte-identical fallback.** Flag off → the old constant, unchanged. You can diff the two paths in CI.
- **Kill-switch without a deploy.** One env var or one setting reverts everything.
- **Per-surface rollout.** Leave a surface on legacy by simply not wiring it yet.
- **Precedence is visible.** If a higher layer (a grounding/persona engine) supplies `systemPromptOverride`, it wins the `??` chain first: `override ?? composed ?? legacy`.

For the **user message**, wire the envelope the same way: if the surface already assembled and sanitized its context, wrap that block verbatim and escape only the new turn and task; guard with `hasEnvelope()` so a pre-composed message is never wrapped twice.

## 4. Measure: paired A/B with a blind judge

Design that produced trustworthy numbers:

| Element | Choice | Why |
|---|---|---|
| Unit | a **pair**: same question + same context, one answer via legacy prompt, one via composer | isolates the prompt variable |
| Volume | 600 pairs per run, 9 runs; vary scenarios across runs (modes, safety probes, formats, latency) | single runs lie; tails matter |
| Generator | one cheap fast model for both arms | cost; the *prompt* is the variable |
| Judge | a **different** model, **blind** to which arm is which, scoring on a rubric per category | removes self-preference and position bias (randomize A/B order per pair) |
| Scoreboard | categories won (e.g. 29/32), judge totals (18.87 vs 16.51), per-pair W-L-T (310-155-103) | three views catch different failure shapes |
| Size | compiled prompt chars per surface, before/after | the cost/latency story (−49…−87 % on heavy routes; +7 % on one small surface) |
| Cache | a warm-cache run separately | caching is the point of the stable prefix; measure it |

Read the losses, not just the wins. The codebase's losses were concentrated in one surface (short typed chat got 7 % longer because it now carried the full security block) and were accepted on purpose and written down.

**LLM-as-judge caveat.** A model judge rewards "sounds good". Pair it with deterministic checks (validator pass rate, sentinel leaks, banned-character counts, word budgets) and a small human-read sample. Never cut over on judge totals alone.

## 5. Cut over — and keep the evidence

- Flip `default: true`. Keep the kill-switch documented in the same comment block as the default.
- **Commit the benchmark artifacts** (scenario set, raw pairs, judge outputs, scoreboard) next to the code. The codebase in question referenced a `COMPLETE-WIN.md` results file that was never committed, and its 216-line migration doc was deleted the same day in an unrelated cleanup commit. A year later the only evidence the composer is better is a commit message.
- Update the flag's *type-level* comment. The same codebase still says "Default OFF everywhere" eight screens above `default: true`.
- Run the live-model eval you deferred for cost. "Not run in this session (no API key spend)" followed by a cutover is a gap, not a footnote.

## 6. Remove the constants only after a full release cycle

Legacy stays until the flag has been default-ON through a full release with no kill-switch use. Then delete the constants **and** the `??` fallbacks together — a `?? undefined` left behind is a trap for the next reader.

## 7. Expect a V3

The composer solves *prompt structure*. It does not solve *evidence composition* — who renders the profile, the job description, the documents, the past-meeting memory into the prompt. In the source codebase, eleven independent sites were still emitting profile blocks directly into provider-bound strings after V2 shipped; a third layer ("one canonical composer, one implementation") was built to own that and sits *above* V2 in the `??` chain, passing V2's base (persona, voice laws, layout, coding contract) in as an input. Plan for the stack to be:

```
   evidence/persona engine   (owns: what is known, who the user is)       ─┐
        ↓ personaBase, systemPromptOverride                                 │  each layer wins the
   prompt composer           (owns: block order, mode × action, gates)     ├─ `??` chain over the
        ↓ ?? null                                                           │  one below it
   legacy constants          (owns: nothing; kill-switch only)             ─┘
```

## Pitfalls checklist

- [ ] A call site calls the composer directly instead of `composed ?? legacy` → no rollback for that surface.
- [ ] The flag is cached at module load → flips don't take effect in tests or across bundled copies.
- [ ] Custom instructions rendered inside the turn envelope → demoted to untrusted data; they belong in the system prompt, escaped and capped.
- [ ] The envelope re-escapes an already-sanitized context block → corrupted structure; pass it verbatim in its own tag.
- [ ] A surface's provider adapter still appends its own persona text → double identity; adapters own syntax and limits only.
- [ ] The silence sentinel is allowed but one sink doesn't suppress it → users see the literal string.
- [ ] The final-check block was added but the core still ends with its own "final check" → two competing checks; keep one, last.
- [ ] The benchmark's A/B order is fixed → position bias inflates one arm.
- [ ] Results live only in the commit message.
