# Voice Enforcement — spoken-output contracts and the deterministic post-model pass

When a product's output is **spoken aloud by the user** (interview copilot, sales call assistant, teleprompter) or **read as the user's own words**, "sounds like an AI" is a product failure, not a style nit. The fix has two layers, and the second exists because the first is probabilistic.

```
  prompt ASKS  ──►  model writes  ──►  code ENFORCES  ──►  budget TRIMS  ──►  diversity GUARDS  ──►  UI
  (contracts)                          (regex pass)       (word/seconds)     (no repeated openers)
```

## Layer 1 — what the prompt asks for

Three separate contract blocks, each owning one failure class. Keep them separate so a fix to one does not disturb the others.

### 1a. Anti-AI-tells (lives in the core identity)

Owns **vocabulary, punctuation, and structure inside spoken prose**.

| Category | Ban | Why |
|---|---|---|
| Words | "delve", "leverage (verb)", "navigate (figurative)", "tapestry", "it's worth noting", "great question", "certainly!" | statistically the strongest lexical fingerprints of generated text |
| Punctuation | em dash, en dash, hyphen-as-dash, semicolon | unspeakable on the tongue; the em dash is the single strongest visual tell |
| Structure | headers, bullet lists, numbered lists in a conversational reply | nobody speaks a bullet |
| Hedging | "could potentially", "it's possible that" used to sound vague | grounded uncertainty is required; vague padding is banned |

Give **paired examples** (bad → good) for the punctuation rule; models follow demonstrations better than rules. Allow light human hedges ("honestly", "basically", "so"), one self-correction ("well, more accurately…"), concrete nouns, "I" sentences. Allow sparing `**bold**` on 1–3 load-bearing terms (bold is silent; it helps the user re-find the line on screen).

Scope the bans explicitly: they apply to spoken/prose passages only, never to code blocks, math, tables, or structural labels. Without the scope line the model strips semicolons from code.

### 1b. Human-spoken contract (composed only into spoken surfaces)

Owns **corporate filler and answer shape** — the failures real sessions show even when facts are right.

- Start with the answer, not a wind-up.
- First person when speaking as the candidate/seller.
- 2–4 sentences; one concrete example beats three generic claims.
- Never narrate the source ("based on my resume", "according to the job description").
- Banned filler list, and — important — **"rewrite the idea, not the phrase"** with a translation table ("proven track record" → "I've done this before"). Without the rewrite instruction the model swaps one cliché for a neighbour.
- Final self-check: "if it sounds like it belongs on a professional networking site, rewrite it in plain speech."

Compose this block **only** into spoken modes/actions. Never into notes, recaps, JSON summaries, code-only output, or diagrams — those keep their structure.

### 1c. Spoken-answer length shapes

Owns **how long**. Three shapes, chosen by a decision order, not a topic list:

| Shape | Budget | Use |
|---|---|---|
| SPOKEN_SHORT (default) | ~25–85 words, 15–30 s; yes/no ≈ 25–40 words | most answers |
| SPOKEN_FULL | ~100–180 words, still prose, still first person | multi-part question, real trade-off, behavioral story, negotiation, safety caveats |
| STRUCTURED_FULL | >180 words, structure allowed | code, system design, notes, recap, tables |

Decision order: (1) explicit user format wins ("one sentence", "shorter" = cut ≥40 %); (2) spoken live → SHORT; (3) SHORT would be incomplete/misleading/unsafe → FULL; (4) task is structural → STRUCTURED; (5) unsure → shorter. Provide a short list of **rotating natural openers** and forbid reusing the same first words on consecutive answers.

## Layer 2 — what the code enforces

### 2a. The deterministic humanizer (final-answer boundary)

Runs once on the finished answer (or at the stream's end). Style-only, fact-preserving, fence-safe. Order matters:

```
 1. PROTECT   pull out fenced code, block math, inline code, inline math → placeholders
 2. STRIP     sentence-initial source narration ("Based on your resume, ", "According to the JD, ")
 3. PERSON    "the candidate built" → "I built"   (safe frames only, case-preserving)
 4. IDIOMS    corporate phrase → plain phrase      (longest match first, grammatical drop-ins)
 5. PUNCT     digit—digit → digit-digit  (keep "5-10")
              word — word → "word, word"
              " -- " → ", "
              "; next" → ". Next"   (capitalize)
 6. RESTORE   placeholders back
```

Original implementation sketch:

```ts
// humanizeSpoken.ts — deterministic, idempotent, never touches code or math.
const FENCE   = /```[\s\S]*?```/g;
const BMATH   = /\$\$[\s\S]*?\$\$/g;
const ICODE   = /`[^`\n]+`/g;
const IMATH   = /\$[^$\n]+\$/g;
const OPEN = '\uE000', CLOSE = '\uE001';           // private-use sentinels; no surrounding spaces

const SOURCE_NARRATION = /^(?:based on|according to|per|from) (?:my|your|the) (?:resume|profile|job description|notes)[,:]?\s*/i;
const THIRD_TO_FIRST: Array<[RegExp, string]> = [
  [/\bthe candidate (has|had|is|was|built|led|worked)\b/gi, 'I $1'],
];
const IDIOMS: Array<[RegExp, string]> = [
  [/\bproven track record\b/gi, "I've done this before"],
  [/\bmove the needle\b/gi, 'make a real difference'],
  [/\bactionable insights\b/gi, 'things the team can actually use'],
  [/\bunique blend of\b/gi, 'the useful part of my background is'],
];

export function humanizeSpoken(answer: string): string {
  if (!answer) return answer;
  const vault: string[] = [];
  let text = answer.split(OPEN).join('').split(CLOSE).join('');   // defence: strip stray sentinels
  const protect = (re: RegExp) => { text = text.replace(re, m => { vault.push(m); return `${OPEN}${vault.length - 1}${CLOSE}`; }); };
  protect(FENCE); protect(BMATH); protect(ICODE); protect(IMATH);   // 1

  text = text.replace(SOURCE_NARRATION, '');                          // 2
  for (const [re, to] of THIRD_TO_FIRST) text = text.replace(re, to); // 3
  for (const [re, to] of IDIOMS)         text = text.replace(re, to); // 4

  text = text.replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2');                // 5 numeric ranges survive
  text = text.replace(/\s*[—–]\s*/g, ', ');
  text = text.replace(/\s+--\s+/g, ', ');
  text = text.replace(/;\s+(\w)/g, (_, c: string) => '. ' + c.toUpperCase());
  text = text.replace(/;\s*$/gm, '.');

  return text.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, i) => vault[Number(i)]);   // 6
}
```

Before → after:

```
in : Based on my resume, the candidate led the platform rewrite — it cut deploy time from 40 minutes to 5; honestly the hard part was schema drift. Complexity is O(n); see `a — b`.
out: I led the platform rewrite, it cut deploy time from 40 minutes to 5. Honestly the hard part was schema drift. Complexity is O(n). See `a — b`.
```

The inline code survived untouched; the numeric range stayed a hyphen; the semicolon became a sentence break with capitalization.

Design notes:
- **Idempotent**: running it twice changes nothing. Tests should assert `f(f(x)) === f(x)`.
- **Private-use sentinels with no spaces** so restoring never swallows an adjacent space and a literal "PROT0" in the answer cannot collide.
- Keep a **detector** alongside the rewriter (`detectCorporateFiller(text) → {hit, phrases}`) for telemetry and tests; the detector is how you learn which new phrases to add.
- The pass is for the *spoken* answer types only; gate it on the planner's answer type, not on a string sniff.

### 2b. Speakability budget

Count spoken words **excluding** fenced code, inline code, and math; estimate seconds at ~2.5–3 words/s. Classify against soft (45–85 words) and hard (100 words / 35 s) limits. Trim **only above the hard cap**, conservatively from the tail at a sentence boundary, and never when the answer type is one that legitimately runs long (behavioral story, comparison, explicit "in detail"). Log the decision; do not silently chop.

### 2c. Diversity guard

Keep the last N answer fingerprints per session (first sentence, scaffold shape). Over a 200-question session the same opener reappearing reads as canned even when each answer is fine alone. On a hit, either re-ask with an "avoid this opening" hint or swap in an alternate opener from the rotation list.

### 2d. Style detection from the question

Deterministic, regex-only, before the model call: "quickly introduce yourself" → 20-second target; "walk me through your background" → 60–90 s; "just the code" → code with no prose; "explain X to a beginner" → simple concept shape. Emit a **style directive** the prompt appends and a length hint the budget uses. Never let this change routing, voice, grounding, or leak boundaries — it shapes form only.

### 2e. Validator (shape + grounding)

A validator that checks the *contract* the prompt promised: coding answers carry the fixed sections; spoken answers carry no headings; grounded answers cite only supplied evidence; identity answers never borrow the assistant's own name. Validators are the reason contracts are written as **checkable shapes** (named sections, word caps, banned characters) rather than adjectives ("be concise").

## Why both layers, every time

| Only the prompt | Only the code |
|---|---|
| 1 em dash in 50 answers still leaks; the user reads it aloud as a pause that isn't there | the model writes LinkedIn prose and the regex swaps five phrases; the *shape* is still wrong |
| compliance varies by provider and by prompt length | cannot fix length, rhythm, or a wind-up opener |
| a new model version shifts behaviour overnight | cannot know which terms to bold |

The prompt sets the target; the code guarantees the floor. Ship them together and test them separately (prompt: judged A/B; code: unit tests with `f(f(x)) === f(x)` and fence-safety cases).
