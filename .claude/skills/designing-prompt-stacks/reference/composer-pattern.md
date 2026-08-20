# The Composer Pattern — block stack, turn envelope, reference implementation

This is the structural half of the skill: how a system prompt is *assembled* per request. Content (what the blocks say) is the product's business; structure (what blocks exist, in what order, varying by what) is what transfers between products.

## 1. Inputs to one composition

```
buildSystemPrompt({
  mode,                // who is speaking / the setting        e.g. 'sales' | 'interview' | 'lecture' | 'custom'
  action,              // what shape comes out                  e.g. 'answer' | 'what_to_say' | 'recap' | 'title'
  tier,                // 'cloud' (big model) | 'local' (small on-device model) — picks the core variant
  codingTask?,         // this turn was classified as a coding problem → attach the coding contract
  codingTaskKind?,     // 'algorithm' (fixed walkthrough sections) | 'build' (code-first implementation)
  codingFormat?,       // explicit user format ("just the code", "only the complexity") overrides the section shape
  readSurface?,        // the answer is READ in a panel, not spoken → attach the scannable layout block
  customInstructions?, // user-authored pinned text → escaped + capped
})
```

Every field is either an **axis** (mode, action, tier) or an **activation** (a boolean/enum the deterministic planner set before the call). No field is free text the model wrote.

Unknown values fall back to safe defaults (`mode → 'general'`, `action → 'answer'`, `tier → 'cloud'`). A typo in a call site must degrade to a sane prompt, not throw mid-stream.

## 2. The block stack, in order

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ 1  CORE (by tier)                                                            │  STABLE across the
 │    identity · security laws · grounding laws · universal formatting          │  whole session →
 │    cloud core: full text. local core: a few lines for a small model.         │  provider cache hit
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 2  MODE  <active_mode name="…">                                              │  who speaks, what
 │    5–10 lines: speaker, register, what this setting rewards/punishes         │  setting
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 3  ACTION  <active_action name="…">                                          │  output shape
 │    3–6 lines: exactly what to produce                                        │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 4  SILENCE GATE  (computed from action by a code lookup)                     │  may the model say
 │    passive-monitor actions: "emit the no-op sentinel for empty moments"      │  nothing?
 │    every other action: "the user invoked this; the sentinel is invalid"     │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 5  VOICE CONTRACT  (mode × action)                                           │  resolves the two
 │    "MODE sets who is speaking; ACTION sets what you produce; neither         │  axes' conflicts
 │     erases the other." + spoken-human overlay when the surface is spoken     │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 6  CODING CONTRACT  (only when codingTask)                                   │  fixed sections a
 │    the validator-checkable section shape, or the explicit user format        │  validator can test
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 7  READ-SURFACE LAYOUT  (only when readSurface)                              │  lists/labels allowed
 │    lead sentence → labelled sections → quotable close                        │  when nobody speaks it
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 8  <custom_instructions>  (escaped, capped ~1,200 chars)                     │  user config, NOT
 │    rendered for any mode that carries pinned user text                       │  evidence
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ 9  FINAL CHECK  (by tier)  — ALWAYS LAST                                     │  hard laws restated
 │    numbered self-verification: grounding, confidentiality, correct speaker,  │  at the recency
 │    silence verdict obeyed, spoken-format bans, output only the result        │  position
 └──────────────────────────────────────────────────────────────────────────────┘
```

### Why this order

| Position | Reason |
|---|---|
| Core first | Identical for every request in a session → the provider can cache the prefix. Anything that varies must come *after* everything that doesn't. |
| Mode before action | Action text is written assuming a speaker already exists ("output what *this role* should say"). |
| Silence gate right after action | It is a property of the action; keeping them adjacent makes the contradiction impossible ("answer" + "may stay silent"). |
| Voice contract after both axes | It refers to both by name and arbitrates them. |
| Coding contract before the read-surface layout | The layout block says "lists allowed"; prompt recency would let that loosen the contract's fixed sections if it came later. The layout's own precedence line defers to the contract. |
| Custom instructions near the end | They must be *seen*, but they must not be *last* — whatever is last wins. |
| Final check last | Measured failure in the source codebase: a confirmation rule placed about 2k characters into the prompt was being skipped by the time the model reached output ~11k characters on. Recency is the strongest position in a prompt; the laws go there, after the user's text, so the user cannot override them. |

### The local tier

Small on-device models cannot hold a 7k-char core. The local core is a few lines, the local final check is one paragraph, and everything else is the *same* mode/action blocks. A cloud→local downgrade mid-session recomposes the same `{mode, action, activations}` on the small tier — the registry keeps a descriptor per composed prompt so the downgrade path can rebuild it without the original call-site arguments.

## 3. The turn envelope (user message)

```
 <evidence_set>
   <evidence rank="1" kind="profile"  source="resume.pdf">   …escaped…   </evidence>
   <evidence rank="2" kind="document" source="handbook.md">  …escaped…   </evidence>
 </evidence_set>

 <recent_transcript>
   …escaped rolling transcript…
 </recent_transcript>

 <current_turn>
   …escaped newest utterance…
 </current_turn>

 <task>
   …escaped typed request, or a default "respond per the active mode and action"…
 </task>
```

Rules:

- **Ranked evidence first, ask last.** Long-context behaviour: put the reading material before the question.
- **Escape at exactly one boundary.** Every dynamic string is XML-escaped here so a document containing `</evidence_set>` cannot close the trusted wrapper. If an upstream stage already assembled and sanitized a context block, wrap it verbatim in a distinct tag (`<assembled_context>`) and escape only the new turn and task — re-escaping corrupts legitimate structure.
- **Guard against double-wrapping.** A cheap `includes('<current_turn>')` check at the chokepoint stops a pre-composed message from being enveloped twice.
- **Custom instructions ride the system prompt, not the envelope.** Inside the envelope they would be demoted to untrusted data; they are user configuration.

## 4. Reference implementation (original, TypeScript)

```ts
// promptComposer.ts — one composer for every mode × action × tier.
// Blocks are short strings in lookup tables; the function only orders them.

type Mode   = 'general' | 'sales' | 'interview' | 'lecture' | 'support' | 'custom';
type Action = 'assist' | 'answer' | 'what_to_say' | 'clarify' | 'recap' | 'title';
type Tier   = 'cloud' | 'local';

interface ComposeInput {
  mode: Mode;
  action: Action;
  tier?: Tier;
  codingTask?: boolean;
  readSurface?: boolean;
  customInstructions?: string;
}

const CORE: Record<Tier, string> = {
  cloud: `<identity>…who the assistant is, what it never reveals…</identity>
<laws>…grounding: never invent personal facts; confidentiality; obey the active mode and action…</laws>`,
  local: `You are a live conversation assistant. Follow the active mode and action. Never invent personal facts.`,
};

const MODES: Record<Mode, string> = {
  general:   `<active_mode name="general">Adapt to the setting without announcing it.</active_mode>`,
  sales:     `<active_mode name="sales">You are the seller's voice, first person, warm, consultative.</active_mode>`,
  interview: `<active_mode name="interview">You are the candidate's voice, first person, ready to say aloud.</active_mode>`,
  lecture:   `<active_mode name="lecture">You are a note-taker. Capture structure, not opinions.</active_mode>`,
  support:   `<active_mode name="support">You are the agent's voice. Resolve, confirm, close.</active_mode>`,
  custom:    `<active_mode name="custom">Follow the custom instructions for voice and setting.</active_mode>`,
};

const ACTIONS: Record<Action, string> = {
  assist:      `<active_action name="assist">Monitor the newest turn; offer only the most useful immediate help.</active_action>`,
  answer:      `<active_action name="answer">Answer the newest question in the mode's voice.</active_action>`,
  what_to_say: `<active_action name="what_to_say">Output only the exact words to say next. No coaching, no quotes.</active_action>`,
  clarify:     `<active_action name="clarify">Ask the single most useful clarifying question.</active_action>`,
  recap:       `<active_action name="recap">Summarize the conversation so far as short bullets.</active_action>`,
  title:       `<active_action name="title">Produce a 3–6 word title. Nothing else.</active_action>`,
};

// Boundary as data, not prose: only passive monitoring may stay silent.
const NO_ACTION = '[[NO_ACTION]]';
const SILENCE_ALLOWED: ReadonlySet<Action> = new Set(['assist']);

function silenceGate(action: Action): string {
  return SILENCE_ALLOWED.has(action)
    ? `<silence_gate>If the newest turn is filler, small talk, or not addressed to the user, output exactly ${NO_ACTION} and nothing else.</silence_gate>`
    : `<silence_gate>The user invoked this action. ${NO_ACTION} is not a valid response here; this overrides any mention of silence elsewhere.</silence_gate>`;
}

// Which actions are "informational" (their shape wins over the mode's role voice).
const INFORMATIONAL: ReadonlySet<Action> = new Set(['recap', 'title', 'clarify']);

function voiceContract(mode: Mode, action: Action): string {
  const shape = INFORMATIONAL.has(action)
    ? `Produce exactly this action's shape; do not replace it with a spoken reply in the mode's role voice.`
    : `Produce this action's shape in the mode's speaker voice.`;
  return `<voice_contract>MODE (${mode}) sets who is speaking. ACTION (${action}) sets what you produce. Neither erases the other. ${shape}</voice_contract>`;
}

const CODING_CONTRACT = `<coding_contract>…fixed sections the validator checks: restate, approach, code, complexity, tests, pitfalls…</coding_contract>`;
const READ_LAYOUT     = `<read_surface_layout>The reader scans this in a panel. Lead sentence, then short labelled sections, then one quotable line. This defers to any coding contract above.</read_surface_layout>`;

const CUSTOM_MAX = 1_200;
function cleanCustom(text?: string): string {
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.trim().slice(0, CUSTOM_MAX);
}

const FINAL_CHECK: Record<Tier, string> = {
  cloud: `<final_check>Before you output, verify in order:
1. Personal facts and numbers come from the evidence or the conversation. If a personal detail is unknown, say it needs checking rather than guessing.
2. Anything labelled internal stays out of the reply, including while refusing.
3. The speaker matches the mode, and the output matches this action's format.
4. The silence gate's decision was respected.
5. Spoken text: no dashes, no semicolons, no bullet points, no headings.
Reply with the answer only.</final_check>`,
  local: `<final_check>Facts from evidence only. Nothing internal. Right speaker, right format. Silence gate respected. Spoken text has no dashes or lists. Reply with the answer only.</final_check>`,
};

export function buildSystemPrompt(input: ComposeInput): string {
  const tier   = input.tier ?? 'cloud';
  const mode   = MODES[input.mode]     ? input.mode   : 'general';   // safe default, never throw
  const action = ACTIONS[input.action] ? input.action : 'answer';

  const parts: string[] = [
    CORE[tier],                       // 1 stable, cacheable
    MODES[mode],                      // 2 who
    ACTIONS[action],                  // 3 what
    silenceGate(action),              // 4 lookup, not prose
    voiceContract(mode, action),      // 5 arbitration
  ];
  if (input.codingTask)  parts.push(CODING_CONTRACT);   // 6
  if (input.readSurface) parts.push(READ_LAYOUT);       // 7 after the contract on purpose

  const custom = cleanCustom(input.customInstructions);
  if (custom) parts.push(`<custom_instructions>\n${custom}\n</custom_instructions>`);   // 8

  parts.push(FINAL_CHECK[tier]);      // 9 ALWAYS last
  return parts.join('\n\n').trim();
}

// ---- turn envelope -------------------------------------------------------

interface EvidenceBlock { kind: string; source?: string; content: string }
interface TurnInput {
  evidence?: EvidenceBlock[];
  recentTranscript?: string;
  currentTurn: string;
  directRequest?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildTurnContent(input: TurnInput): string {
  const out: string[] = [];
  const evidence = (input.evidence ?? []).filter(b => b.content?.trim());
  if (evidence.length) {
    const rendered = evidence.map((b, i) =>
      `<evidence rank="${i + 1}" kind="${b.kind}"${b.source ? ` source="${esc(b.source)}"` : ''}>\n${esc(b.content.trim())}\n</evidence>`);
    out.push(`<evidence_set>\n${rendered.join('\n')}\n</evidence_set>`);
  }
  if (input.recentTranscript?.trim()) out.push(`<recent_transcript>\n${esc(input.recentTranscript.trim())}\n</recent_transcript>`);
  out.push(`<current_turn>\n${esc(input.currentTurn.trim())}\n</current_turn>`);
  out.push(`<task>\n${esc(input.directRequest?.trim() || 'Respond to the current turn per the active mode and action.')}\n</task>`);
  return out.join('\n\n');
}

export const hasEnvelope = (msg?: string | null) => !!msg && msg.includes('<current_turn>');
```

What to notice in the sketch:

- `MODES` and `ACTIONS` are **data**. Adding a mode is adding a table row, not writing a prompt.
- `silenceGate` and `voiceContract` are the only functions with logic, and the logic is a `Set` membership test.
- The composer **never throws** — bad inputs degrade to defaults because it runs in the hot path of a streaming answer.
- `cleanCustom` both escapes and caps; neither alone is enough (escaped 40k chars still swamps the prompt).
- `hasEnvelope` exists because a second wrapping at the chokepoint is a silent, hard-to-spot bug.

## 5. Sentinel handling is a multi-sink problem

If an action may emit a no-op sentinel, *every* place output lands must recognize it: the streaming gate (so partial `[[NO_` never paints), session storage (so silence is never persisted as an answer), any mirror surface (phone, second window), and the engine's own history. Ship a `couldBecomeSentinel(buffer)` prefix check for the stream and a `shouldSuppress(output)` check for the sinks. One forgotten sink means users see the literal sentinel.

## 6. Display markup is a separate, tiny layer

Spoken answers can still carry *visual* aids the ear never hears: at most a few `**bold**` key terms, and an optional one-line "gist" chip marked with its own sentinel on the last line. Keep this as a post-pass (`splitGistLine`, `stripDisplayMarkup`) with a renderer twin, not as more prose in the prompt. The final check pins it ("at most three marks; gist line last") so the model and the renderer agree.
