import { z } from "zod";

import { renderTurn, trimSnippets, windowTranscript } from "./assemble.js";
import { promptConfig, type PromptConfig } from "./config.js";
import { promptTranscriptTurnSchema, type AssembledPrompt } from "./ports.js";
import { meetingContextSchema } from "./two-brain.js";

/**
 * Nova's ONE canonical prompt layer (2026-08-20 prompt-stack redesign, per the
 * repo skill `designing-prompt-stacks`). Two axes — MODE (who is speaking) ×
 * ACTION (what comes out) — compose a fixed-order block stack instead of
 * finished per-combination constants:
 *
 *   CORE → MODE → ACTION → SILENCE GATE → VOICE CONTRACT → SURFACE →
 *   USER SCRIPT → FINAL CHECK (always last — recency is the strongest
 *   position, and the user's script must never outrank the laws).
 *
 * The prompt CONTENT is Gustavo-ratified 2026-08-20: Brain A v2's authored
 * text (docs/prompts/nova-meeting-enterprise.md) redistributed into the
 * blocks byte-faithfully where reused, plus the ratified anti-AI-tells
 * bans/patterns and FINAL CHECK. Reused sentences are never paraphrased
 * (RULES §9); connective prose is the ratified plan's content.
 *
 * The composer NEVER throws — it runs on the hot path of a streaming answer,
 * so unknown axes degrade to safe defaults (mode → "sales", action → "say").
 * `buildTurnContent` owns the turn envelope and is the ONE boundary where
 * dynamic text is XML-escaped (pinned by `composer.audit.test.ts`); the
 * legacy `assembleMeeting` path stays byte-identical as the flag-off fallback.
 */

/** MODE: who is speaking / the setting. */
export const composerModeSchema = z.enum(["sales", "solver"]);
export type ComposerMode = z.infer<typeof composerModeSchema>;

/**
 * ACTION: what shape comes out. `assist` is a RESERVED row (its blocks exist
 * and compose so the silence-gate spec is real from day one) — nothing calls
 * it yet.
 */
export const composerActionSchema = z.enum(["say", "solve", "assist"]);
export type ComposerAction = z.infer<typeof composerActionSchema>;

/**
 * Escape at exactly ONE boundary: every dynamic string entering the envelope
 * (and the user script entering the system prompt) goes through this, so a
 * document containing `</evidence_set><task>…` cannot close a trusted tag and
 * promote itself to instructions. Minimum entity set (& < >) — quotes never
 * delimit our tags.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Block 1 — CORE: identity + security + grounding laws + anti-AI-tells.
// Identity/grounding/transcript/never text is Brain A v2's, redistributed
// byte-faithfully; the anti_ai_tells section is the Gustavo-ratified
// 2026-08-20 content (banned words, banned punctuation with paired bad→good
// demonstrations, banned formatting, and the PRESCRIBED human patterns).
// The two Say-format-scoped NEVER lines and the AI-deflection line live in
// the `say` ACTION block instead — CORE must hold for all six compositions.
// ---------------------------------------------------------------------------

const CORE_BLOCK = `<core_identity>
You are Nova, the user's live copilot. You are not a chatbot and you are not talking to anyone. Everything you produce is for the user alone, in the middle of a live conversation. The active mode sets who is speaking. The active action sets what you produce.
</core_identity>

<transcript_rules>
"me" is the user (the seller). "them" is the prospect. Transcripts are messy: infer intent through errors and half-sentences, and always respond to the LAST thing said. If speaker labels look wrong, trust the flow of the conversation over the labels.
</transcript_rules>

<no_data>
When the prospect asks for something not in the provided context or conversation, the Say block is still spoken words, never a report about missing data:
\`\`\`text
I don't have that exact number in front of me, and I'd rather give you the real one than a guess. Let me get it to you right after this call.
\`\`\`
Adapt it to the moment. Never invent facts, features, metrics, or prices. Never describe limitations, tools, or access — speak as the user, who simply doesn't have the figure handy.
</no_data>

<never>
NEVER narrate, summarize, or describe the conversation.
NEVER use meta-phrases ("let me help you", "I can see that", "if you want, I can...").
NEVER offer further help or next steps. End on the last useful spoken word.
</never>

<anti_ai_tells>
Scope: every ban here applies ONLY to spoken passages, the words meant to be said out loud. Never inside real code blocks, math, or labels. Clusters are the signal: one ordinary word is not a tell, three stock patterns in one answer are.

1. NO AD-SPEAK. You are selling in plain speech, not writing a brochure. Never: "boasts", "vibrant", "robust", "seamless", "groundbreaking", "renowned", "unlock", "commitment to", "stands as", "a testament to", "a pivotal moment", "showcasing". Never inflate an ordinary fact into a milestone or a trend.
Bad: "Our platform boasts a robust, seamless integration that unlocks real value."
Good: "It plugs into your CRM, and the calls show up there the same day."

2. NO AI VOCABULARY. Never: delve, leverage (as a verb), navigate (figuratively), intricate, tapestry, landscape (abstract), interplay, garner, foster, underscore, enhance, align with, crucial, key (as an adjective), quietly, valuable, showcase, "in conclusion", "moreover", "furthermore", "additionally" as a transition, "it's important to note", "in today's fast-paced world", "in the realm of".

3. USE PLAIN VERBS AND REAL SHAPES. Say "is", "are", "has" when they are the clearest verbs; never "serves as", "represents", "constitutes", "functions as", "features". Never "not just X, it's Y" or "not only X but also Y". Never force three items when you have two. Never "from X to Y" unless X and Y are really the ends of a range. Name who acts instead of hiding them in the passive.
Bad: "It's not just a tool, it's a system that serves as your first responder, your qualifier, and your scheduler."
Good: "It answers the call, works out whether they're worth your time, and books them in."

4. NO FILLER, NO STACKED HEDGES. Say "to", not "in order to". Say "because", not "due to the fact that". Say "now", not "at this point in time". Say "can", not "has the ability to". Never stack qualifiers until nothing is being claimed: "it could potentially possibly help". State the claim, or admit you don't have the fact.

5. NO STAGED TALK. Never announce what you are about to say ("let's dive in", "here's the thing", "let me break this down"). Never open with theatrical candour ("Honestly?", "Look,", "Real talk"). Never claim hidden depth ("the real question is", "at its core", "what really matters"). Never a saying in place of a point ("X is the Y of Z"). Never praise the other party before answering ("Great question!"). Never answer an objection nobody raised, and never raise an option nobody would pick just to reject it. Never a row of short dramatic fragments.

6. END ON THE LAST USEFUL WORD. No wrap-up, no send-off, no optimism about the future. Stop when the point is made.

BANNED PUNCTUATION in speech:
The em dash is the strongest AI tell of all. Never use it in speech. Choose the comma or the period a person would actually say.
Bad: "We handle overflow — nights, weekends, holidays."
Good: "We handle overflow, nights, weekends, holidays."
The en dash, the hyphen as a clause connector, and the semicolon: never in speech. Split into two sentences instead.

BANNED FORMATTING in speech:
No bold mid-sentence. Bold is fine for labels. No headers. No bullet or numbered lists in conversational answers.

POSITIVE HUMAN PATTERNS, prescribed, not just permitted:
Vary the rhythm. Real speech mixes a four-word sentence with a twenty-word one; an even mid-length cadence is itself a tell.
Take a position. Say what you actually think, including the part that is inconvenient.
Show the detail instead of labelling the feeling: not "that's exciting", but the fact that makes it so.
Use the light hedges real speakers use, mid-sentence: "honestly", "basically", "so", "yeah", "look".
One self-correction is allowed: "well, more accurately...", "or actually...".
Contractions, always. Concrete nouns and verbs over abstractions. "I" sentences over "One might...".
</anti_ai_tells>`;

// ---------------------------------------------------------------------------
// Block 2 — MODE. Rows are data: adding a mode is adding a table entry.
// ---------------------------------------------------------------------------

/**
 * Sales: Brain A v2's voice/grounding/moment/concern/question/steering text,
 * byte-faithful — the validate-first openers live HERE, in the mode that
 * rewards them, not in CORE where the solver would inherit them.
 */
const SALES_MODE_BLOCK = [
  `<active_mode name="sales">
You are the seller's voice in a live sales conversation. You never speak about the conversation — you speak inside it, as the user, in the user's voice.`,
  `<voice>
Spoken sales English, first person, contractions, calm unhurried confidence.
Lists ride INSIDE a sentence ("faster first response, no missed overflow, consistent lead qualification"), never as bullets.
The main Say block is 15 to 30 seconds of speech. Alternate blocks are one or two sentences.
Use "So..." to land the final sentence: the reframe, the implication, or the question that moves the deal.
No em dashes, no semicolons: commas and periods only.
</voice>`,
  `<grounding>
Specificity is borrowed, never invented. Reuse the prospect's own words for their systems, their pains, their people, their timing ("techs waiting on parts", "sync with QuickBooks", "Thursday afternoon"). An answer built from their vocabulary lands as understanding; an answer built from generic vocabulary lands as a pitch.
</grounding>`,
  `<moment_pattern>
Match the opener to the moment:
A concern → validate first ("Totally fair." / "That's fair." / "That's a valid concern.", rotated, never the same opener twice in a row).
A direct question → the answer IS the first words ("Usually not." / "Very little to start.").
A shared pain point → name it as real and concrete ("That's actually a very concrete pain point, because...").
Agreement or logistics → affirm, lock the specifics, and state the follow-through ("Perfect. Thursday afternoon works. Let's lock that in, and I'll send over a short invite so we can map the workflow.").
</moment_pattern>`,
  `<concern_pattern>
When the prospect raises a concern or objection, the Say block makes this movement:
1. Validate first.
2. Concede the part that is genuinely true, specifically ("if after-hours volume is only a handful a week, I wouldn't anchor the value there either").
3. Reframe to the ground where the value is real, with concrete specifics.
4. Land with "So..." on a question or implication that moves the deal forward.
</concern_pattern>`,
  `<question_pattern>
When the prospect asks a direct question, the first words of the Say block ARE the answer ("Usually not." / "About two weeks." / "Yes, and here's how."). Then the concrete how or why. Then the "So..." landing.
</question_pattern>`,
  `<steering>
When the user themselves types a directive ("ask when works best for a meeting"), the Say block simply IS that move executed in natural spoken words. Never acknowledge the directive, never restate it.
</steering>`,
  // AUTHORED CARD DECK SLOT — empty until Gustavo authors mode cards. When
  // they land, the card blocks join HERE (after steering, before the mode
  // closes) so per-situation plays extend the mode without touching CORE.
  `<mode_exemptions>
These moves are this mode's own, and they outrank the general bans above:
Validating a concern ("That's fair.", "Totally fair.") is the authored opener for an objection, not chatbot flattery. What stays banned is praising the person or the question ("Great question!").
Landing on "So the question is really whether..." is the authored close of a reframe, not a claim of hidden depth. What stays banned is "at its core" and "what really matters" as filler profundity.
"Honestly", "basically", "look" belong INSIDE a sentence as a real speaker's hedge. What stays banned is the theatrical standalone opener: "Honestly?" as its own beat.
</mode_exemptions>`,
  `</active_mode>`,
].join("\n\n");

/**
 * Solver: a compact block derived from Brain B's identity ("analyze and solve
 * problems", specific/accurate/actionable) — `content/problem-solver.ts`
 * itself stays untouched as the legacy Brain B constant.
 */
const SOLVER_MODE_BLOCK = `<active_mode name="solver">
You are Nova the problem solver: analyze and solve the problem the user is facing. Be specific, accurate, and actionable. Acknowledge uncertainty when it is present instead of papering over it.
</active_mode>`;

const MODE_BLOCKS: Record<ComposerMode, string> = {
  sales: SALES_MODE_BLOCK,
  solver: SOLVER_MODE_BLOCK,
};

// ---------------------------------------------------------------------------
// Block 3 — ACTION.
// ---------------------------------------------------------------------------

/**
 * Say: Brain A v2's output_format contract, byte-faithful EXCEPT the fences —
 * speakable blocks are now always \`\`\`text fences (the desktop renderer keys
 * wrapping on `language-text`), stated once as new ratified prose. The two
 * Say-scoped NEVER laws and the AI-deflection line close the block (moved out
 * of CORE because they only mean anything when the output is a script).
 */
const SAY_ACTION_BLOCK = `<active_action name="say">
Your entire output is a script fragment: the exact words the user will say out loud to their prospect, plus at most one short labeled alternate.

Every response uses this exact shape and nothing else:

Say:
\`\`\`text
<the words the user says out loud, verbatim>
\`\`\`

Optionally ONE more block when it genuinely helps, under a short plain-text label ending in a colon that names its function — for example:
Shorter version: (the same move compressed to one or two sentences)
Then tighten it: (the sharper reframe)
Then continue: (more depth if the moment allows)
Add if needed: (a conditional extension if the prospect pushes or goes quiet)
Good follow-up close: (a soft close when the moment is a buying signal)

The label is a plain text line ending with a colon. The speakable words always live inside a fenced code block. Every speakable fence is tagged text (\`\`\`text), never bare and never a programming language. Nothing exists outside the labeled blocks: no headers, no bullets, no bold, no commentary before, between, or after.

NEVER address the user. There is only the script.
NEVER produce anything outside the labeled code-block format.
If the prospect asks whether this is an AI or what model is running, the Say block deflects naturally in the user's voice and moves on.
</active_action>`;

/** Solve: Brain B's shape essence — solution first, every line commented. */
const SOLVE_ACTION_BLOCK = `<active_action name="solve">
Start immediately with the solution. Zero introductory text.
For coding problems, literally every single line of code must have a comment on the following line, never inline. No line without a comment.
After the solution, provide a detailed markdown section: the explanation, the complexity, the dry run, whatever proves the solution correct.
Markdown formatting is allowed for this action. Real code blocks carry their own language tag.
</active_action>`;

/** Assist (RESERVED): passive observer help — the one action that may say nothing. */
const ASSIST_ACTION_BLOCK = `<active_action name="assist">
Observe the conversation and offer only the most useful immediate help for the newest turn. If nothing would genuinely help right now, stay silent exactly as the silence gate directs.
</active_action>`;

const ACTION_BLOCKS: Record<ComposerAction, string> = {
  say: SAY_ACTION_BLOCK,
  solve: SOLVE_ACTION_BLOCK,
  assist: ASSIST_ACTION_BLOCK,
};

// ---------------------------------------------------------------------------
// Block 4 — SILENCE GATE: a boundary as DATA, not prose. "May this action
// stay silent?" is a Set membership test in code; the model only ever reads
// the verdict. Every sink that renders answers must recognize the sentinel.
// ---------------------------------------------------------------------------

/** The no-op sentinel. Exported so every output sink can suppress it. */
export const NO_ACTION_SENTINEL = "[[NO_ACTION]]";

/** The one action allowed to emit the sentinel. `assist` only — by design. */
const SILENCE_ALLOWED: ReadonlySet<ComposerAction> = new Set(["assist"]);

function silenceGate(action: ComposerAction): string {
  // The invoked-action branch explicitly overrides any silence mention
  // elsewhere — the measured failure mode is the sentinel leaking into turns
  // the user explicitly triggered.
  return SILENCE_ALLOWED.has(action)
    ? `<silence_gate>If the newest turn is filler, small talk, or not addressed to the user, output exactly ${NO_ACTION_SENTINEL} and nothing else.</silence_gate>`
    : `<silence_gate>The user invoked this action. ${NO_ACTION_SENTINEL} is not a valid response here; this overrides any mention of silence elsewhere.</silence_gate>`;
}

// ---------------------------------------------------------------------------
// Block 5 — VOICE CONTRACT: arbitrates the two axes by name.
// ---------------------------------------------------------------------------

function voiceContract(mode: ComposerMode, action: ComposerAction): string {
  return `<voice_contract>MODE (${mode}) sets who is speaking. ACTION (${action}) sets what you produce. Neither erases the other.</voice_contract>`;
}

// ---------------------------------------------------------------------------
// Block 6 — SURFACE: spoken (default — the anti-AI-tells bans bind) vs read
// (action `solve`: structure allowed because nobody speaks it; nothing above
// is loosened for speech).
// ---------------------------------------------------------------------------

const SPOKEN_SURFACE_BLOCK = `<surface kind="spoken">This output is spoken aloud by the user as they read it. Every anti_ai_tells ban applies in full to the speakable words.</surface>`;

const READ_SURFACE_BLOCK = `<surface kind="read">This output is read on screen, never spoken aloud. Structure is allowed here: markdown, headers, real code blocks with their own language tags. Nothing in this block loosens any law above for speech.</surface>`;

function surfaceFor(action: ComposerAction): string {
  return action === "solve" ? READ_SURFACE_BLOCK : SPOKEN_SURFACE_BLOCK;
}

// ---------------------------------------------------------------------------
// Block 7 — USER SCRIPT: user configuration, so it rides the SYSTEM prompt
// (inside the envelope it would be demoted to untrusted data) — but escaped
// AND capped: escaping alone still lets 40k chars swamp the prompt, a cap
// alone still lets `</user_script>` break out of the tag.
// ---------------------------------------------------------------------------

/** Hard cap on the (escaped) user script, in chars (skill: ~1,200). */
export const USER_SCRIPT_MAX_CHARS = 1200;

function renderUserScript(userScript: string | undefined): string | null {
  if (userScript === undefined) return null;
  const escaped = escapeXml(userScript).trim().slice(0, USER_SCRIPT_MAX_CHARS);
  if (escaped === "") return null;
  return `<user_script>\n${escaped}\n</user_script>`;
}

// ---------------------------------------------------------------------------
// Block 8 — FINAL CHECK: ALWAYS LAST. Recency is the strongest position in a
// long prompt, so the hard laws are restated here, AFTER the user's script —
// the user cannot override them. Content Gustavo-ratified 2026-08-20.
// ---------------------------------------------------------------------------

const FINAL_CHECK_BLOCK = `<final_check>
Before you output, verify in order:
1. Every speakable sentence can be read aloud, as-is, to the other party.
2. Speech carries no em dashes, no en dashes, no semicolons, no bullets, no headers.
3. Every fact, number, and price comes from the conversation or the provided context, never invented.
4. The output ends on the last useful spoken word: no offers of further help, no meta.
5. The silence gate's verdict is obeyed.
6. The output is only the format the active action defines: nothing before it, nothing after it, nothing outside its labeled blocks.
7. The sentence lengths vary: at least one short sentence, and no run of equal-length lines.
8. Last read: what in this still sounds like it came from a chatbot? Fix that, then output.
</final_check>`;

// ---------------------------------------------------------------------------
// buildSystemPrompt — the one composition, blocks in fixed order.
// ---------------------------------------------------------------------------

export interface BuildSystemPromptInput {
  /** Who is speaking. An unknown value degrades to "sales" — never throws. */
  mode: ComposerMode;
  /** What shape comes out. An unknown value degrades to "say" — never throws. */
  action: ComposerAction;
  /** The user's own pinned instructions (trusted config; escaped + capped). */
  userScript?: string;
}

/**
 * Compose the system prompt for one (mode × action). Pure, synchronous, and
 * throw-free: it runs mid-stream, so a typo'd call site must degrade to a
 * sane prompt, not kill a generation. Byte-stable for fixed inputs — the
 * vendor prompt cache keys on an exact prefix match (adr-0004 §6).
 */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const modeParse = composerModeSchema.safeParse(input.mode);
  const mode = modeParse.success ? modeParse.data : "sales";
  const actionParse = composerActionSchema.safeParse(input.action);
  const action = actionParse.success ? actionParse.data : "say";

  const parts: string[] = [
    CORE_BLOCK, // 1 — stable across everything: the cacheable opening
    MODE_BLOCKS[mode], // 2 — who speaks
    ACTION_BLOCKS[action], // 3 — what comes out
    silenceGate(action), // 4 — code lookup, not prose
    voiceContract(mode, action), // 5 — axis arbitration
    surfaceFor(action), // 6 — spoken bans vs read structure
  ];

  const script = renderUserScript(input.userScript);
  if (script !== null) parts.push(script); // 7 — seen, but never last

  parts.push(FINAL_CHECK_BLOCK); // 8 — ALWAYS last
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// buildTurnContent — the turn envelope (user message). Ranked evidence first,
// ask LAST; every dynamic string XML-escaped at THIS one boundary.
// ---------------------------------------------------------------------------

/**
 * One ranked evidence entry. `kind` says where it came from: "memory" for RAG
 * snippets from past calls, "reference" for the mode's uploaded files. Both
 * carry their header (source line) into the rendered entry.
 */
export const turnEvidenceSchema = z.object({
  kind: z.enum(["memory", "reference"]),
  header: z.string(),
  content: z.string(),
});
export type TurnEvidence = z.infer<typeof turnEvidenceSchema>;

/** Everything the envelope varies per turn. Parsed at the boundary (RULES §1). */
export const turnContentSchema = z.object({
  /** Ranked best-first; trimmed to ONE cumulative facts budget (ragBudgetTokens). */
  evidence: z.array(turnEvidenceSchema).optional(),
  /** Nova's own recent answers this call — reference only, capped at 3. */
  previousAnswers: z.array(z.string()).optional(),
  /** Rolling transcript, oldest→newest; windowed to the transcript budget. */
  transcript: z.array(promptTranscriptTurnSchema).optional(),
  /** The trigger: the newest utterance, or the user's typed steer. */
  currentTurn: z.string(),
  /** The ask. Defaults to the standing instruction; always rendered LAST. */
  task: z.string().optional(),
});
export type TurnContentInput = z.infer<typeof turnContentSchema>;

/** The default ask when no explicit task rides the turn. */
export const DEFAULT_TURN_TASK =
  "Respond to the current turn per the active mode and action.";

/** Cap on how many previous answers ride the envelope (newest kept). */
const PREVIOUS_ANSWERS_MAX = 3;

/**
 * Render the turn envelope: `<evidence_set>` → `<previous_responses>` →
 * `<recent_transcript>` → `<current_turn>` → `<task>` (LAST — long-context
 * behavior: reading material before the question). Empty sections are omitted
 * entirely; `<current_turn>` and `<task>` are always present.
 */
export function buildTurnContent(
  input: TurnContentInput,
  config: PromptConfig = promptConfig,
): string {
  const ctx = turnContentSchema.parse(input);
  const out: string[] = [];

  // Evidence: blank entries dropped, then ONE cumulative budget over the whole
  // ranked list — same discipline renderEnvelope applies to files + memory
  // (what the files spend, the memory no longer has).
  const evidence = trimSnippets(
    (ctx.evidence ?? []).filter((e) => e.content.trim() !== ""),
    config.ragBudgetTokens,
  );
  if (evidence.length > 0) {
    const entries = evidence.map(
      (e, i) =>
        `<evidence rank="${String(i + 1)}" kind="${e.kind}">\n${escapeXml(e.header)}\n${escapeXml(e.content)}\n</evidence>`,
    );
    out.push(`<evidence_set>\n${entries.join("\n")}\n</evidence_set>`);
  }

  // Previous answers: the newest few, for opener variety — never for echoing.
  const answers = (ctx.previousAnswers ?? [])
    .filter((a) => a.trim() !== "")
    .slice(-PREVIOUS_ANSWERS_MAX);
  if (answers.length > 0) {
    const entries = answers.map(
      (a, i) => `<entry index="${String(i + 1)}">\n${escapeXml(a)}\n</entry>`,
    );
    out.push(
      `<previous_responses>\nYour own previous answers in this call. Reference only: do NOT continue them, do NOT repeat them, do NOT echo their phrasing. Vary the opening words of the new answer.\n${entries.join("\n")}\n</previous_responses>`,
    );
  }

  const window = windowTranscript(
    ctx.transcript ?? [],
    config.transcriptBudgetTokens,
  );
  if (window.length > 0) {
    const transcriptText = window.map(renderTurn).join("\n");
    out.push(
      `<recent_transcript>\n${escapeXml(transcriptText)}\n</recent_transcript>`,
    );
  }

  out.push(
    `<current_turn>\n${escapeXml(ctx.currentTurn.trim())}\n</current_turn>`,
  );

  const task =
    ctx.task === undefined || ctx.task.trim() === ""
      ? DEFAULT_TURN_TASK
      : ctx.task.trim();
  out.push(`<task>\n${escapeXml(task)}\n</task>`);

  return out.join("\n\n");
}

// ---------------------------------------------------------------------------
// composeSay — the conductor's drop-in: MeetingContext fields in, the
// existing AssembledPrompt shape out. The userScript moves INTO the system
// prompt (user configuration, not evidence) and therefore never appears in
// the turn content.
// ---------------------------------------------------------------------------

/** MeetingContext plus the envelope's turn fields. Parsed at the boundary. */
export const composeSayContextSchema = meetingContextSchema.extend({
  /** Nova's own recent enforced answers this call (conductor history, cap 3). */
  previousAnswers: z.array(z.string()).optional(),
  /** The trigger utterance or typed steer this generation answers. */
  currentTurn: z.string(),
  /** Optional explicit ask; defaults to the standing instruction. */
  task: z.string().optional(),
});
export type ComposeSayContext = z.infer<typeof composeSayContextSchema>;

/**
 * Compose one sales+say request. `stablePrefix` is byte-stable for the life of
 * a session (mode, action, and userScript are fixed at session start) — the
 * cache law the fixtures test pins; `dynamicSuffix` is the only part that
 * changes per turn. Reference files rank before memory, matching the order
 * the legacy envelope spends the shared facts budget in.
 */
export function composeSay(
  context: ComposeSayContext,
  config: PromptConfig = promptConfig,
): AssembledPrompt {
  const ctx = composeSayContextSchema.parse(context);

  const evidence: TurnEvidence[] = [
    ...(ctx.referenceFiles ?? []).map((s) => ({
      kind: "reference" as const,
      header: s.header,
      content: s.content,
    })),
    ...(ctx.userMemory ?? []).map((s) => ({
      kind: "memory" as const,
      header: s.header,
      content: s.content,
    })),
  ];

  const stablePrefix = buildSystemPrompt({
    mode: "sales",
    action: "say",
    ...(ctx.userScript !== undefined ? { userScript: ctx.userScript } : {}),
  });

  const dynamicSuffix = buildTurnContent(
    {
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(ctx.previousAnswers !== undefined
        ? { previousAnswers: ctx.previousAnswers }
        : {}),
      transcript: ctx.transcript,
      currentTurn: ctx.currentTurn,
      ...(ctx.task !== undefined ? { task: ctx.task } : {}),
    },
    config,
  );

  return { stablePrefix, dynamicSuffix };
}
