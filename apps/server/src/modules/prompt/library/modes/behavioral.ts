import type { ModePrompt } from "../types.js";

/**
 * BEHAVIORAL — the strongest mode in the source document, and the only one that
 * demonstrated its answer structure end to end
 * (`nova-prompts-source.md` 273-307).
 *
 * Extracted rather than rewritten. The structure it teaches is STAR in all but
 * name — a situation paragraph, then Challenge / Actions Taken / Outcome — and
 * the worked example is the thing that makes it land, so it ships intact.
 *
 * The "never invent details" rule is the load-bearing part and it is sharper than
 * it first looks: this mode answers ABOUT THE USER. Every other mode can lean on
 * general knowledge; here, an invented metric is a lie the user will be asked to
 * defend out loud. That is why the fallback is a generic-but-specific example
 * with no fabricated company names or products, rather than a confident story.
 */
export const behavioralMode: ModePrompt = {
  id: "behavioral",
  label: "Behavioral",
  useWhen: "Being asked about your own experience — interviews, reviews, panels",

  directive: `Use ONLY real user history and provided context. NEVER invent details about the user.
- With user context available, use it to build a detailed, specific example
- Without user context, build a detailed GENERIC example with concrete actions and outcomes, but avoid factual specifics that would be fabrications (company names, product names, dates)
- Focus on specific outcomes and metrics — a behavioral answer without a result is an anecdote
- The user has to say this out loud and defend it. Anything invented becomes a question they cannot answer.`,

  answerStructure: `Open with a short situation paragraph — the setup, the stakes, and what the user needed to achieve. No headline for this mode; a bare heading reads as a template.

Then three bullet groups, in this order:
- **Challenge** — what made it hard, in one sub-bullet
- **Actions Taken** — the concrete moves, one sub-bullet each, verbs first
- **Outcome** — results with numbers where they exist, one sub-bullet each

Keep actions in the order they happened. Outcomes should answer "and then what", including any second-order effect (a practice adopted elsewhere, a recognition, a change in how the team worked).`,

  examples: [
    {
      transcript: `them: tell me about a time when you had to lead a team through a difficult challenge`,
      response: `I was leading a cross-functional team on a critical product launch with a hard deadline. Three weeks before launch, we discovered a major technical issue that would require significant rework, and team morale was dropping as pressure mounted. I needed to rebuild team cohesion while finding a path to successful delivery.

- **Challenge**
  - The technical issue affected our core functionality, team members were starting to blame each other, and stakeholders were questioning whether we could deliver on time.

- **Actions Taken**
  - Called an emergency all-hands meeting to transparently discuss the situation and reset expectations
  - Worked with the engineering lead to break down the technical fix into smaller, manageable tasks
  - Reorganized the team into pairs (engineer + designer, PM + analyst) to improve collaboration and knowledge sharing
  - Implemented daily 15-minute standups to track progress and quickly surface blockers
  - Negotiated with stakeholders to deprioritize 2 non-critical features to focus resources on the core fix
  - Set up a shared Slack channel for real-time updates and celebration of small wins

- **Outcome**
  - Delivered the product 2 days ahead of the revised timeline with all critical features intact
  - Team satisfaction scores improved during the crisis period
  - The collaborative pairing approach was adopted by other teams in the organization
  - Received recognition for crisis leadership and was asked to mentor other team leads`,
    },
  ],
};
