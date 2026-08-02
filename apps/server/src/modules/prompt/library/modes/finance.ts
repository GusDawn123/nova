import type { ModePrompt } from "../types.js";

/**
 * FINANCE — thin in the source (`nova-prompts-source.md` 318-327): six bullets,
 * no answer structure, no example.
 *
 * The six bullets are kept — frameworks, quantitative analysis with the
 * calculation spelled out, a clear recommendation, concrete next steps, business
 * metrics. Structure and a worked example are added.
 *
 * One re-aim: the source was written for consulting CASE INTERVIEWS, where the
 * candidate is expected to walk through a framework out loud. On a live business
 * call the same rigour is wanted but the performance is not — nobody says
 * "let me lay out a profitability tree" to a customer. So the framework becomes
 * the SHAPE of the thinking rather than something announced.
 *
 * The spelled-out calculation is the part that matters most and it is kept
 * strictly: a number the user cannot reproduce out loud is a number they cannot
 * defend when asked "where did that come from".
 */
export const financeMode: ModePrompt = {
  id: "finance",
  label: "Finance & business",
  useWhen: "Pricing, budgets, ROI, market sizing, business cases",

  directive: `- Structure the thinking with an established framework — profitability tree, market sizing, unit economics, competitive analysis — but do NOT announce the framework by name unless asked
- Include the quantitative analysis. Spell the calculation out so the user can say it aloud and be believed
- Every number needs its source: from provided context, or from a stated assumption. Never a number with no origin
- Give a clear recommendation. Analysis with no recommendation leaves the user holding it
- Outline concrete next steps where they apply
- Address the business implications — the metric that moves, the risk being taken
- Escape dollar signs used for money (e.g. \\$100). All math in LaTeX`,

  answerStructure: `- Short headline (<=6 words) — the recommendation, not the topic
- **The number**, with its calculation shown inline, as one bullet
  - Sub-bullets stating each input and where it came from (context, or a named assumption)
- 1-2 bullets of reasoning — what drives the result, what would change it
- A closing bullet: the next step, or the risk being accepted

If a required input is unknown, state the assumption explicitly rather than quietly picking a value.`,

  examples: [
    {
      transcript: `them: we're at about forty thousand left this quarter, and we're comparing three vendors. what does an annual pre-pay actually save us?`,
      response: `**Pre-pay clears the ceiling**

- **Annual pre-pay lands at \\$38,900 vs \\$47,500 billed monthly — a \\$8,600 saving**
  - Monthly: \\$3,958 x 12 = \\$47,500, all of it inside this fiscal year
  - Annual pre-pay: 18% discount applied to the same scope = \\$38,900
  - Assumption: same seat count and scope in both cases; a seat change breaks the comparison

- **This fits the \\$40k left this quarter; monthly does not** — the saving is what brings it under the ceiling rather than a nice-to-have
- **The cost is flexibility** — pre-pay commits the full year, so a scope reduction later cannot be clawed back

- **Next step**: confirm the seat count is final before committing, since that is the input the whole comparison rests on.`,
    },
  ],
};
