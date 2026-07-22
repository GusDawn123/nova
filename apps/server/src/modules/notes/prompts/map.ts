import type { ChatMessage } from "../../llm/index.js";

import { REPAIR_SYSTEM_PROMPT } from "./system.js";

/**
 * The MAP-step prompt (adr-0006 §5). Each chunk of an over-budget transcript is
 * mapped independently to STRUCTURED facts + a 3-sentence mini-summary — never to
 * prose that the reduce step would have to re-mine (that is where early-call facts
 * die). The extraction shape mirrors the notes fields so the reduce step can MERGE
 * facts in code rather than re-derive them. Portable, ONLY-JSON, same idioms as the
 * single-pass generate prompt (transcript at the TOP, schema at the BOTTOM).
 */

const MAP_SYSTEM_PROMPT = [
  "You extract structured facts from ONE SEGMENT of a longer phone call.",
  "You see only this segment — extract only what THIS segment actually contains; never guess at what came before or after.",
  "",
  "Rules you must never break:",
  "- Respond with ONLY a single JSON object. No prose, no markdown, no code fences.",
  "- Ground every decision and action item in this segment: include a verbatim quote copied exactly from a line, or null when there is no direct evidence. Never paraphrase inside a quote.",
  "- Owners come only from who spoke in this segment — a named person if named, otherwise the speaker label. Never invent a name.",
  "- Deadlines: an ISO date (YYYY-MM-DD) in `deadline` and the exact spoken phrase in `deadlineRaw`; both null if this segment stated no date. Never guess a date.",
  "- If the segment contains no decisions/action items/etc., return empty arrays. Do not invent content to fill them.",
].join("\n");

/** The compact TS-style schema the map step returns (facts + a mini-summary). */
const MAP_SCHEMA = [
  "{",
  '  "miniSummary": string,   // EXACTLY 3 sentences summarising this segment',
  '  "decisions": { "text": string, "quote": string | null }[],',
  '  "actionItems": {',
  '    "text": string,',
  '    "owner": string | null,       // speaker who owns it (this segment only) or null',
  '    "deadline": string | null,    // ISO date YYYY-MM-DD, or null if none stated',
  '    "deadlineRaw": string | null, // exact spoken phrase (e.g. "by Monday"), or null',
  '    "quote": string | null        // verbatim line from this segment or null',
  "  }[],",
  '  "openQuestions": string[],',
  '  "risks": string[],',
  '  "insights": {',
  '    "objections": string[],       // concerns raised (sales)',
  '    "buyingSignals": string[],    // signals of intent to buy (sales)',
  '    "questionsAsked": string[],   // questions posed (interview)',
  '    "answersToRevisit": string[]  // answers worth a second look (interview)',
  "  }",
  "}",
].join("\n");

/** Build the MAP messages for one chunk (segment transcript top, schema bottom). */
export function buildMapMessages(params: {
  segment: string;
  chunkIndex: number;
  chunkCount: number;
  callDate: string;
  weekday: string;
}): ChatMessage[] {
  const { segment, chunkIndex, chunkCount, callDate, weekday } = params;
  const user = [
    `SEGMENT ${String(chunkIndex + 1)} of ${String(chunkCount)} — TRANSCRIPT:`,
    segment,
    "",
    "---",
    "",
    `The call took place on ${weekday}, ${callDate}. Resolve any relative dates (e.g. "by Monday") to an ISO calendar date relative to that day; if this segment stated no date for an action item, set both deadline and deadlineRaw to null.`,
    "",
    "Return a JSON object of exactly this shape:",
    MAP_SCHEMA,
    "",
    "Return ONLY the JSON object.",
  ].join("\n");

  return [
    { role: "system", content: MAP_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** The ONE repair round-trip for a map chunk — echoes the map schema + zod issues. */
export function buildMapRepairMessages(
  invalidText: string,
  issues: string,
): ChatMessage[] {
  const user = [
    "Your previous response did not match the required schema.",
    "",
    "Required shape:",
    MAP_SCHEMA,
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
