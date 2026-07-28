import type { ConversationType, MeetingNotes, NoteListKey } from "@nova/shared";

import type { ChatMessage } from "../../llm/index.js";

import { REPAIR_SYSTEM_PROMPT } from "./system.js";
import { TYPE_GUIDANCE, calendarTable } from "./types.js";

/**
 * The live-fold prompt (Phase 8, docs/DESIGN/live-notes.md §3). Authored here, not
 * extracted from the Phase 7 verbatim source — that constraint covers the live
 * COPILOT prompt only; notes prompts are original work (adr-0006 §7).
 *
 * The model is asked for OPS against a DIGEST of the current notes, never for the
 * whole notes object. That inversion is the feature's economics: output cost stops
 * scaling with accrued note count (~150 folds on an hour-long call), and a model
 * that is never shown an item's quote structurally cannot rewrite it.
 *
 * The digest carries `id` + `text` ONLY — no quotes, no `deadlineRaw`, no
 * `overview`. The model needs to know what exists and under which id; it does not
 * need the payload back, and sending it would roughly double input tokens for the
 * privilege of letting the model corrupt it.
 */

/** Lists that exist for every conversation type, in prompt order. */
const BASE_LISTS: readonly NoteListKey[] = [
  "decisions",
  "actionItems",
  "openQuestions",
  "risks",
];

/** The insight-arm lists for each type. */
const ARM_LISTS: Record<ConversationType, readonly NoteListKey[]> = {
  sales: ["objections", "buyingSignals"],
  interview: ["questionsAsked", "answersToRevisit"],
  casual: [],
};

/** One-line description of what belongs in each list, shown beside its name. */
const LIST_HINT: Record<NoteListKey, string> = {
  decisions: "something the call actually settled",
  actionItems: "somebody committed to do something",
  openQuestions: "asked but not answered",
  risks: "a concern, blocker, or thing that could go wrong",
  objections: "a concern raised about buying",
  buyingSignals: "a signal of intent to buy",
  questionsAsked: "a question the interviewer posed",
  answersToRevisit: "an answer worth a second look",
};

interface DigestItem {
  readonly id: string;
  readonly text: string;
}

/** The itemized lists of a notes object, in prompt order, for the given type. */
function digestLists(
  notes: MeetingNotes,
  type: ConversationType,
): [NoteListKey, readonly DigestItem[]][] {
  const insights = notes.typeInsights;
  const arm = new Map<NoteListKey, readonly DigestItem[]>();
  if (insights.kind === "sales") {
    arm.set("objections", insights.objections);
    arm.set("buyingSignals", insights.buyingSignals);
  } else if (insights.kind === "interview") {
    arm.set("questionsAsked", insights.questionsAsked);
    arm.set("answersToRevisit", insights.answersToRevisit);
  }
  const base = new Map<NoteListKey, readonly DigestItem[]>([
    ["decisions", notes.decisions],
    ["actionItems", notes.actionItems],
    ["openQuestions", notes.openQuestions],
    ["risks", notes.risks],
  ]);
  return [...BASE_LISTS, ...ARM_LISTS[type]].map((list) => [
    list,
    base.get(list) ?? arm.get(list) ?? [],
  ]);
}

/**
 * Render the prior notes as `id: text` lines per list. A list at its item cap is
 * marked so the model consolidates via `update` instead of spending `add` ops the
 * reducer would only drop.
 */
export function renderNotesDigest(
  notes: MeetingNotes,
  type: ConversationType,
  maxItemsPerList: number,
): string {
  const blocks = digestLists(notes, type).map(([list, items]) => {
    const atCap = items.length >= maxItemsPerList;
    const header = `${list}${atCap ? "  [FULL — consolidate with update, do not add]" : ""}:`;
    const body =
      items.length === 0
        ? "  (none yet)"
        : items.map((item) => `  ${item.id}: ${item.text}`).join("\n");
    return `${header}\n${body}`;
  });
  return blocks.join("\n");
}

/** The fold's system prompt: ops-only, evidence rules, ONLY-JSON. */
export const LIVE_FOLD_SYSTEM_PROMPT = [
  "You maintain a running set of notes for a phone call that is STILL IN PROGRESS.",
  "You are given the notes so far (id and text only) and the newest stretch of transcript.",
  "You return a small list of OPERATIONS that bring the notes up to date. You never return the notes themselves.",
  "",
  "Rules you must never break:",
  "- Respond with ONLY a single JSON object. No prose, no markdown, no code fences.",
  "- Return the FEWEST operations that capture what is genuinely new. Most stretches of a call warrant one or two, and returning none is a perfectly good answer.",
  "- Only ever `update` or `retract` an id that appears in the notes above. Never invent an id, and never reuse one for something different.",
  "- Never restate an item that is already there. If the new transcript only refines an existing item, `update` it; if it adds nothing, leave it alone.",
  "- `retract` is for something the call has since contradicted or resolved — not for tidying, rewording, or reorganising.",
  "- An item you do not mention is KEPT. You do not need to repeat the notes to preserve them.",
  "- Ground decisions and action items in the transcript: `quote` is copied verbatim from a line, or null when there is no direct evidence. Never paraphrase inside a quote.",
  "- Owners come only from who spoke. Never invent a name.",
  "- Deadlines: an ISO date (YYYY-MM-DD) in `deadline` and the exact spoken phrase in `deadlineRaw`, or both null. Never guess a date nobody said.",
].join("\n");

/** The ops schema, in the compact TS style the notes prompts use throughout. */
function opsSchemaText(
  type: ConversationType,
  narrativeOpen: boolean,
  narrativeRequired: boolean,
): string {
  const lists = [...BASE_LISTS, ...ARM_LISTS[type]];
  const listUnion = lists.map((list) => `"${list}"`).join(" | ");
  const hints = lists.map((list) => `//   ${list} — ${LIST_HINT[list]}`);
  const narrative = narrativeOpen
    ? [
        `  "narrative": {           // ${
          narrativeRequired
            ? "REQUIRED on this update — these notes have no summary yet"
            : "optional; only when the call has moved on enough to warrant it"
        }`,
        '    "title": string,       // <= 8 words naming the call',
        '    "tldr": string,        // one sentence',
        '    "overview": string     // 2-4 sentences',
        "  },",
      ]
    : [];
  return [
    "{",
    '  "ops": [',
    `    { "op": "add",     "list": ${listUnion}, "item": <item> },`,
    `    { "op": "update",  "list": <same>, "id": "<an id from above>", "item": <item> },`,
    `    { "op": "retract", "list": <same>, "id": "<an id from above>", "reason": string }`,
    "  ],",
    ...narrative,
    '  "conversationType": "sales" | "interview" | "casual"   // optional; only if the call is clearly no longer casual',
    "}",
    "",
    "// which list to use:",
    ...hints,
    "",
    '// <item> for decisions:   { "text": string, "quote": string | null }',
    '// <item> for actionItems: { "text": string, "owner": string | null, "deadline": string | null, "deadlineRaw": string | null, "quote": string | null }',
    '// <item> for every other list: { "text": string }',
  ].join("\n");
}

export interface FoldMessageParams {
  readonly type: ConversationType;
  /** The prior-notes digest (id + text only) — see {@link renderNotesDigest}. */
  readonly digest: string;
  /** The newest stretch of transcript, rendered `[mm:ss] Speaker: text`. */
  readonly delta: string;
  readonly callDate: string;
  /** Closed → the narrative section is omitted AND the reducer ignores it (§4). */
  readonly narrativeOpen: boolean;
  /**
   * These notes still carry the placeholder title/tldr, so the narrative is not
   * an option on this fold — it is the job.
   *
   * Offering it ("only when the call has moved on enough to warrant it") is the
   * right framing for every LATER fold and exactly the wrong one for the first:
   * a reasonable model declines on a call that has barely started, and the tab
   * then shows "Notes are still forming." next to a populated list until the
   * cadence opens the window again. Caught by the e2e, 2026-07-26.
   */
  readonly narrativeRequired?: boolean;
}

/** Build the fold messages: notes digest, then the new transcript, then the schema. */
export function buildFoldMessages(params: FoldMessageParams): ChatMessage[] {
  const { type, digest, delta, callDate, narrativeOpen } = params;
  const narrativeRequired = params.narrativeRequired ?? false;
  const user = [
    "NOTES SO FAR:",
    digest,
    "",
    "NEW TRANSCRIPT SINCE THE LAST UPDATE:",
    delta,
    "",
    "---",
    "",
    TYPE_GUIDANCE[type],
    "",
    `The call is taking place on ${callDate}. Resolve any relative dates using the calendar below.`,
    calendarTable(callDate),
    "",
    narrativeOpen
      ? narrativeRequired
        ? "These notes have NO summary yet, so you MUST return a narrative (title, tldr, overview) on this update, however early the call is. Write it from what you have."
        : "You may also refresh the narrative (title/tldr/overview) on this update."
      : "Do NOT return a narrative on this update — only operations.",
    "",
    "Return a JSON object of exactly this shape:",
    opsSchemaText(type, narrativeOpen, narrativeRequired),
    "",
    "Return ONLY the JSON object.",
  ].join("\n");

  return [
    { role: "system", content: LIVE_FOLD_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** The ladder's one repair round-trip for a fold response. */
export function buildFoldRepairMessages(
  type: ConversationType,
  narrativeOpen: boolean,
  invalidText: string,
  issues: string,
): ChatMessage[] {
  const user = [
    "Your previous response did not match the required schema.",
    "",
    "Required shape:",
    opsSchemaText(type, narrativeOpen, false),
    "",
    "Your invalid output:",
    invalidText,
    "",
    "Problems found:",
    issues,
    "",
    "Preserve all valid operations, return ONLY the corrected JSON object.",
  ].join("\n");

  return [
    { role: "system", content: REPAIR_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}
