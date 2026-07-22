import type { ConversationType } from "@nova/shared";

import type { ChatMessage } from "../../llm/index.js";

import { exampleFor } from "./examples.js";
import { CLASSIFY_SYSTEM_PROMPT, NOTES_SYSTEM_PROMPT } from "./system.js";

/**
 * Per-conversation-type prompt content + the generate/classify message builders.
 * Compact TS-style schema (adr-0006 §7: ~4× fewer tokens than JSON Schema, equally
 * followed) with per-field comments, one small example, transcript at the TOP and
 * schema/instructions at the BOTTOM (the itemized-extraction ordering the design
 * calls for). `version` and `source` are omitted — the pipeline stamps them.
 */

/** The `typeInsights` arm text for each conversation type. */
const INSIGHTS_ARM: Record<ConversationType, string> = {
  sales:
    '{ "kind": "sales", "objections": string[], "buyingSignals": string[] }  // concerns raised; signals of intent to buy',
  interview:
    '{ "kind": "interview", "questionsAsked": string[], "answersToRevisit": string[] }  // questions posed; answers worth a second look',
  casual: '{ "kind": "casual" }  // no extra section',
};

/** One short paragraph of type-specific guidance, injected above the schema. */
const TYPE_GUIDANCE: Record<ConversationType, string> = {
  sales:
    "This was a SALES call. Capture pricing, objections, and buying signals precisely; action items are commitments (who sends what, by when).",
  interview:
    "This was an INTERVIEW. Capture the questions asked and any answers worth revisiting; open questions are gaps to probe in a later round.",
  casual:
    "This was a CASUAL conversation. Keep it light: only record an action item if someone genuinely committed to something. Trivial small talk is not an action item.",
};

/** The compact TS-style schema for the given type (the insights arm is pinned). */
function compactSchema(type: ConversationType): string {
  return [
    "{",
    `  "conversationType": "${type}",  // exactly this value`,
    '  "title": string,        // <= 8 words naming the call',
    '  "tldr": string,         // one-sentence summary',
    '  "overview": string,     // 2-4 sentence recap',
    '  "decisions": { "text": string, "quote": string | null }[],  // quote = verbatim transcript line or null',
    '  "actionItems": {',
    '    "text": string,',
    '    "owner": string | null,       // speaker who owns it (transcript only) or null',
    '    "deadline": string | null,    // ISO date YYYY-MM-DD, or null if none stated',
    '    "deadlineRaw": string | null, // exact spoken phrase (e.g. "by Friday"), or null',
    '    "quote": string | null        // verbatim transcript line or null',
    "  }[],",
    '  "openQuestions": string[],',
    '  "risks": string[],',
    `  "typeInsights": ${INSIGHTS_ARM[type]}`,
    "}",
  ].join("\n");
}

/** Build the generate messages: system + a user turn (transcript top, schema bottom). */
export function buildGenerateMessages(params: {
  type: ConversationType;
  transcript: string;
  callDate: string;
  weekday: string;
}): ChatMessage[] {
  const { type, transcript, callDate, weekday } = params;
  const user = [
    "TRANSCRIPT:",
    transcript,
    "",
    "---",
    "",
    TYPE_GUIDANCE[type],
    "",
    `The call took place on ${weekday}, ${callDate}. Resolve any relative dates (e.g. "by Friday", "next Tuesday") to an ISO calendar date relative to that day. If no date was stated for an action item, set both deadline and deadlineRaw to null.`,
    "",
    "Return a JSON object of exactly this shape:",
    compactSchema(type),
    "",
    "Example (shape only — do not copy its content):",
    exampleFor(type),
    "",
    "Return ONLY the JSON object.",
  ].join("\n");

  return [
    { role: "system", content: NOTES_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** Build the classify messages over the transcript head. */
export function buildClassifyMessages(headText: string): ChatMessage[] {
  return [
    { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Opening of the call:\n\n${headText}\n\nOne word — sales, interview, or casual:`,
    },
  ];
}

/** The compact schema text, exported so the repair prompt can echo it. */
export function schemaTextFor(type: ConversationType): string {
  return compactSchema(type);
}
