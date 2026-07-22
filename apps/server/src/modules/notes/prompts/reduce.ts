import type { ConversationType } from "@nova/shared";

import type { ChatMessage } from "../../llm/index.js";

import { REPAIR_SYSTEM_PROMPT } from "./system.js";
import { INSIGHTS_ARM, TYPE_GUIDANCE } from "./types.js";

/**
 * The REDUCE-step prompt (adr-0006 §5). The reduce call writes the NARRATIVE
 * (title / tldr / overview) + the type insights + a consolidation of open
 * questions and risks, from the ORDERED per-segment mini-summaries and the
 * already-merged facts. It does NOT re-extract decisions/action items — those are
 * merged in code and assembled around this call, so an early-segment commitment
 * can never be dropped by a reduce that "forgot" the start of the call. The prompt
 * therefore explicitly demands EQUAL WEIGHT to early and late segments.
 */

/** Merged facts handed to the reduce prompt (already deduped in code). */
export interface ReduceFacts {
  readonly summaries: string[]; // ordered, one per chunk
  readonly decisions: string[];
  readonly actionItems: string[];
  readonly openQuestions: string[];
  readonly risks: string[];
  readonly objections: string[];
  readonly buyingSignals: string[];
  readonly questionsAsked: string[];
  readonly answersToRevisit: string[];
}

const REDUCE_SYSTEM_PROMPT = [
  "You write the final notes for a LONG phone call.",
  "You are given ordered per-segment summaries (segment 1 is the START of the call) and facts already extracted from every segment.",
  "",
  "Rules you must never break:",
  "- Respond with ONLY a single JSON object. No prose, no markdown, no code fences.",
  "- Give EQUAL WEIGHT to early and late segments. Do NOT let the end of the call dominate — the overview must reflect the whole arc, beginning to end.",
  "- Do not invent facts. Base the narrative and insights only on the summaries and facts provided.",
  "- Do not add fields that are not in the schema. Do not omit required fields.",
].join("\n");

/** The compact TS-style schema the reduce step returns (narrative + insights). */
function reduceSchema(type: ConversationType): string {
  return [
    "{",
    '  "title": string,        // <= 8 words naming the whole call',
    '  "tldr": string,         // one-sentence summary of the whole call',
    '  "overview": string,     // 2-4 sentences covering the call start-to-end (equal weight)',
    '  "openQuestions": string[],',
    '  "risks": string[],',
    `  "typeInsights": ${INSIGHTS_ARM[type]}`,
    "}",
  ].join("\n");
}

/** Render a labelled bullet list, or `(none)` when empty. */
function bullets(items: string[]): string {
  return items.length === 0 ? "(none)" : items.map((i) => `- ${i}`).join("\n");
}

/** Build the REDUCE messages from the ordered summaries + merged facts. */
export function buildReduceMessages(params: {
  type: ConversationType;
  facts: ReduceFacts;
  callDate: string;
  weekday: string;
}): ChatMessage[] {
  const { type, facts, callDate, weekday } = params;
  const orderedSummaries = facts.summaries
    .map((s, i) => `Segment ${String(i + 1)}: ${s}`)
    .join("\n");

  const user = [
    "ORDERED SEGMENT SUMMARIES (segment 1 = start of call):",
    orderedSummaries === "" ? "(none)" : orderedSummaries,
    "",
    "MERGED DECISIONS (already extracted):",
    bullets(facts.decisions),
    "",
    "MERGED ACTION ITEMS (already extracted):",
    bullets(facts.actionItems),
    "",
    "OPEN QUESTIONS (raw, to consolidate):",
    bullets(facts.openQuestions),
    "",
    "RISKS (raw, to consolidate):",
    bullets(facts.risks),
    "",
    "SALES OBJECTIONS:",
    bullets(facts.objections),
    "SALES BUYING SIGNALS:",
    bullets(facts.buyingSignals),
    "INTERVIEW QUESTIONS ASKED:",
    bullets(facts.questionsAsked),
    "INTERVIEW ANSWERS TO REVISIT:",
    bullets(facts.answersToRevisit),
    "",
    "---",
    "",
    TYPE_GUIDANCE[type],
    "",
    `The call took place on ${weekday}, ${callDate}.`,
    "",
    "Return a JSON object of exactly this shape:",
    reduceSchema(type),
    "",
    "Return ONLY the JSON object.",
  ].join("\n");

  return [
    { role: "system", content: REDUCE_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** The ONE repair round-trip for the reduce call — echoes the reduce schema. */
export function buildReduceRepairMessages(
  type: ConversationType,
  invalidText: string,
  issues: string,
): ChatMessage[] {
  const user = [
    "Your previous response did not match the required schema.",
    "",
    "Required shape:",
    reduceSchema(type),
    "",
    "Your invalid output:",
    invalidText,
    "",
    "Problems found:",
    issues,
    "",
    "Preserve all valid content, return ONLY the corrected JSON object.",
  ].join("\n");
  return [
    { role: "system", content: REPAIR_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}
