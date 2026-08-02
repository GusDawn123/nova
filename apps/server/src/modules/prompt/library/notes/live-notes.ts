import type { CategoryPrompt } from "../types.js";

/**
 * LIVE NOTES — a category, not a mode (Gustavo, 2026-08-01).
 *
 * The distinction is not filing. A MODE is chosen by the user and shapes the
 * answer given TO them. Live notes are never chosen and never answer anybody:
 * they run in the background of every call regardless of mode, and their output
 * is a document that keeps being revised. Putting them in the mode picker would
 * imply they can be switched off by choosing something else, which is false.
 *
 * ADAPTED, not extracted. The source's `summarization_implementation_rules`
 * (399-434) describe an ON-DEMAND recap — fired when someone says "catch me up",
 * explicitly forbidden from running on its own. Ours is the opposite: a
 * continuous rolling fold nobody asks for. So the trigger rules are dropped
 * entirely and only the STYLE guidance carries over, which is the good part:
 * <=3 substantive points, pull from the recent window, and the bad example
 * ("talked about a lot of things... you said some stuff") is a sharper
 * definition of failure than any positive rule in the document.
 *
 * MECHANICS LIVE ELSEWHERE. How a fold is applied — ops against an id+text
 * digest, so the model structurally cannot rewrite a stored quote — is
 * `modules/notes/prompts/live-fold.ts`. This file is about what good notes SOUND
 * like, and the two must not drift into each other.
 */
export const liveNotesCategory: CategoryPrompt = {
  id: "live-notes",
  label: "Live notes",

  notAMode:
    "Runs on every call regardless of the picked mode, and is never selected by the user. Its output is a document that gets revised, not an answer to a person.",

  directive: `- Write what was DECIDED, ASKED and OWED — not what was discussed
- Every point must survive the test: could someone who missed the call act on this?
- Specifics or nothing. Numbers, names, dates and conditions are the content; without them a point is filler
- Prefer the words that were actually said over a paraphrase that smooths them out
- Never pad to reach a count. Two real points beat five hedged ones
- Never invent a decision that was only implied. "Seems to be leaning towards" is not a decision
- Revise rather than append: a later correction replaces the earlier point, it does not sit beside it`,

  answerStructure: `A short summary line, then only the sections that have real content:
- decided — statements of record, each one a thing that is now settled
- action items — who owes what, and by when if a time was said
- open — questions raised and not answered

Omit an empty section entirely. A heading with nothing under it reads as a gap in the notes rather than an absence in the call.`,

  examples: [
    {
      transcript: `Recent window of a sales call covering budget, timeline and security review.`,
      response: `Quick recap:
- Discussed pricing tiers including the \\$38,900 annual pre-pay against \\$47,500 monthly
- Asked about the Slack integration, specifically whether alerts can route per-channel
- Raised a competitor objection: current vendor already covers reporting`,
    },
    {
      transcript: `The same window, written badly — this is the failure mode to avoid.`,
      response: `Talked about a lot of things... you said some stuff about tools, then they replied about pricing and other topics.`,
    },
  ],
};
