import type { FollowUpTone, MeetingNotes } from "@nova/shared";

import type { ChatMessage } from "../../llm/index.js";

/**
 * Authored follow-up prompt content — original work (the Phase 7 verbatim-prompt
 * constraint does NOT apply to notes; adr-0006 §7). The follow-up draft is written
 * FROM the validated notes object ONLY: the builder's input is `MeetingNotes` (never
 * a transcript), so "cites-notes-only" holds by construction (adr §8) and is asserted
 * mechanically on the captured prompt. Portable across whichever vendor the router
 * commits to: a firm "ONLY the JSON object" framing + a compact TS-style schema.
 */

/** The follow-up writer's system prompt: role + the ONLY-JSON contract the ladder needs. */
export const FOLLOW_UP_SYSTEM_PROMPT = [
  "You are Nova's follow-up email writer.",
  "You are given STRUCTURED NOTES from a phone call and write a copy-ready follow-up email.",
  "",
  "Rules you must never break:",
  "- Respond with ONLY a single JSON object. No prose, no markdown, no code fences, no commentary before or after.",
  "- Write ONLY from the notes provided. Do not invent facts, names, numbers, commitments, or dates that are not in the notes.",
  "- Ground the email in the decisions and action items: restate what was agreed and who owns what, using only the notes.",
  "- Do not add fields that are not in the schema. Do not omit required fields.",
].join("\n");

/**
 * Per-tone register directives — DISTINCT instructions so the same notes yield a
 * recognisably different email per tone (adr §8; the mechanical test asserts the
 * three registers diverge).
 */
export const TONE_DIRECTIVE: Record<FollowUpTone, string> = {
  professional: [
    "TONE: professional.",
    "Formal, businesslike register. Complete sentences, courteous but not chatty.",
    "Open with a brief thank-you, summarise the agreed points, and close with clear next steps.",
  ].join("\n"),
  warm: [
    "TONE: warm.",
    "Warm, personable register. Friendly and appreciative, first-person, a human touch.",
    "Sound like a real person who enjoyed the call, while still covering the agreed points and next steps.",
  ].join("\n"),
  brief: [
    "TONE: brief.",
    "Terse register. Keep it very short — a few sentences at most, no filler, no pleasantries beyond a one-line thanks.",
    "Lead with the next steps; cut anything the reader does not strictly need.",
  ].join("\n"),
};

/** The compact TS-style schema the follow-up draft must match (tone is stamped in code). */
const FOLLOW_UP_SCHEMA = [
  "{",
  '  "subject": string,   // a concise email subject line',
  '  "body": string       // the full email body, ready to copy and send',
  "}",
].join("\n");

/** Render one notes decision/action item list as compact lines (notes-only content). */
function renderList(lines: string[]): string {
  return lines.length === 0 ? "(none)" : lines.map((l) => `- ${l}`).join("\n");
}

/**
 * Serialise the notes fields the email draws on — title, tl;dr, overview, decisions,
 * action items (owner + deadline), open questions, risks. This is the ENTIRE content
 * source for the draft: no transcript is available to the builder, so the prompt can
 * only ever contain notes-derived strings (the cites-notes-only guarantee).
 */
function renderNotes(notes: MeetingNotes): string {
  const actionItems = notes.actionItems.map((item) => {
    const owner = item.owner !== null ? ` (owner: ${item.owner})` : "";
    const deadline = item.deadline !== null ? ` [due ${item.deadline}]` : "";
    return `${item.text}${owner}${deadline}`;
  });
  return [
    `TITLE: ${notes.title}`,
    `TL;DR: ${notes.tldr}`,
    `OVERVIEW: ${notes.overview}`,
    "",
    "DECISIONS:",
    renderList(notes.decisions.map((d) => d.text)),
    "",
    "ACTION ITEMS:",
    renderList(actionItems),
    "",
    "OPEN QUESTIONS:",
    renderList(notes.openQuestions.map((q) => q.text)),
    "",
    "RISKS:",
    renderList(notes.risks.map((r) => r.text)),
  ].join("\n");
}

/**
 * Build the follow-up generate messages: system + a user turn (notes at the top, the
 * tone directive + schema at the bottom). The ONLY inputs are the validated notes,
 * the requested tone, and the meeting title — no transcript can reach this prompt.
 */
export function buildFollowUpMessages(params: {
  notes: MeetingNotes;
  tone: FollowUpTone;
  meetingTitle: string;
}): ChatMessage[] {
  const { notes, tone, meetingTitle } = params;
  const user = [
    `Write a follow-up email for this call: ${meetingTitle}`,
    "",
    "NOTES:",
    renderNotes(notes),
    "",
    "---",
    "",
    TONE_DIRECTIVE[tone],
    "",
    "Return a JSON object of exactly this shape:",
    FOLLOW_UP_SCHEMA,
    "",
    "Return ONLY the JSON object.",
  ].join("\n");

  return [
    { role: "system", content: FOLLOW_UP_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/**
 * The repair round-trip prompt for the follow-up draft (adr §7 — one paid retry).
 * Echoes the schema + the model's invalid output + the zod issue paths, then the
 * preserve-and-return-only-JSON law.
 */
export function buildFollowUpRepairMessages(
  invalidText: string,
  issues: string,
): ChatMessage[] {
  const user = [
    "Your previous response did not match the required schema.",
    "",
    "Required shape:",
    FOLLOW_UP_SCHEMA,
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
    {
      role: "system",
      content: [
        "You fix a JSON object that failed schema validation.",
        "Return ONLY the corrected JSON object — no prose, no fences.",
        "Preserve every piece of already-valid content; change only what the reported problems require.",
      ].join("\n"),
    },
    { role: "user", content: user },
  ];
}
