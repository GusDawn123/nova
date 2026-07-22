import type { ConversationType } from "@nova/shared";

/**
 * One small, shape-only example per conversation type — the "ONE example" rung of
 * the portable prompt (adr-0006 §7). Deliberately tiny (a token or two of content
 * per field) so it teaches the SHAPE without biasing the model toward inventing
 * content. `version` and `source` are absent: the pipeline stamps those itself, so
 * the generation schema (and therefore the example) omits them.
 */

const SALES_EXAMPLE = {
  conversationType: "sales",
  title: "Acme pricing call",
  tldr: "Walked Acme through pricing; they want a proposal.",
  overview:
    "Reviewed the plan tiers with Acme's buyer. They raised budget concerns but asked for a written proposal to share internally.",
  decisions: [{ text: "Send a written proposal", quote: "send us a proposal" }],
  actionItems: [
    {
      text: "Send the proposal to Acme",
      owner: "Dana",
      deadline: "2026-03-06",
      deadlineRaw: "by Friday",
      quote: "I'll get the proposal over by Friday",
    },
  ],
  openQuestions: ["Which tier fits their team size?"],
  risks: ["Budget may not be approved this quarter"],
  typeInsights: {
    kind: "sales",
    objections: ["Price is above their current tool"],
    buyingSignals: ["Asked for a proposal to circulate"],
  },
};

const INTERVIEW_EXAMPLE = {
  conversationType: "interview",
  title: "Backend candidate screen",
  tldr: "Screened a backend candidate on systems design.",
  overview:
    "Discussed the candidate's experience with distributed queues and asked a design question. Strong on fundamentals, thin on observability.",
  decisions: [{ text: "Advance to the onsite round", quote: "let's move them to the onsite" }],
  actionItems: [
    {
      text: "Schedule the onsite",
      owner: "Priya",
      deadline: null,
      deadlineRaw: null,
      quote: "I'll set up the onsite next week",
    },
  ],
  openQuestions: ["How deep is their Kafka experience?"],
  risks: ["Limited monitoring experience"],
  typeInsights: {
    kind: "interview",
    questionsAsked: ["Design a job queue on Postgres"],
    answersToRevisit: ["Their approach to backpressure was vague"],
  },
};

const CASUAL_EXAMPLE = {
  conversationType: "casual",
  title: "Catch-up with Sam",
  tldr: "Friendly catch-up; no action items of substance.",
  overview:
    "Traded updates about the week and weekend plans. Nothing was formally decided.",
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  typeInsights: { kind: "casual" },
};

const EXAMPLES: Record<ConversationType, unknown> = {
  sales: SALES_EXAMPLE,
  interview: INTERVIEW_EXAMPLE,
  casual: CASUAL_EXAMPLE,
};

/** The compact, shape-only example JSON string for a conversation type. */
export function exampleFor(type: ConversationType): string {
  return JSON.stringify(EXAMPLES[type], null, 2);
}
