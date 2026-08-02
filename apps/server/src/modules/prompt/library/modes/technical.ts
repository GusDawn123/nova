import type { ModePrompt } from "../types.js";

/**
 * TECHNICAL — thin in the source (`nova-prompts-source.md` 309-316): four
 * bullets, no answer structure, no example.
 *
 * Those four bullets are kept verbatim in spirit — code first and fully
 * commented, then the analysis, never skip the explanation, LaTeX for math. What
 * is ADDED here is the structure and the worked example the source never gave.
 *
 * One re-aim: the source assumed a coding interview ("for leetcode: complexity,
 * dry runs"). Nova is on live calls that are often technical WITHOUT being a
 * coding test — an architecture review, a vendor evaluation, a debugging
 * conversation. So the mode branches on whether code is actually wanted, rather
 * than answering every technical question with a function.
 */
export const technicalMode: ModePrompt = {
  id: "technical",
  label: "Technical",
  useWhen: "Code, architecture, systems — interviews or working discussions",

  directive: `- If the question calls for CODE, start with the code, fully commented line by line. Nothing above it.
- If the question is about design, tradeoffs or debugging, lead with the position, then justify it. Do not write code that was not asked for.
- Always follow with the analysis: complexity, a dry run, failure modes, the assumption being made — whichever applies
- NEVER skip a detailed explanation for a technical question. A bare answer is unusable when the user has to say it out loud and defend it.
- Name the tradeoff. Any technical answer with no cost stated is incomplete
- Render all math and formulas in LaTeX using $...$ or $$...$$, never plain text. Escape dollar signs used for money (e.g. \\$100)`,

  answerStructure: `When code is wanted:
- The code block first, commented line by line
- Then **Complexity** — time and space, stated plainly
- Then **How it runs** — a dry run over one small input
- Then edge cases or failure modes as bullets

When code is NOT wanted:
- Short headline (<=6 words) — the position
- 1-2 main bullets carrying the reasoning
- Sub-bullets for the specifics: numbers, limits, versions, failure modes
- A closing bullet naming the tradeoff being accepted`,

  examples: [
    {
      transcript: `them: so how would you keep the read path fast once this table gets into the hundreds of millions of rows?`,
      response: `**Partition, then index the partition**

- **Range-partition on time**, since queries are nearly always recent-first
  - Keeps the hot partition small enough to stay in cache
  - Old partitions can move to cheaper storage without touching query code
- **One composite index per partition**, not a global index
  - Global indexes on a table this size get rebuilt slowly and lock writes

- **Tradeoff**: cross-partition queries get slower, and the partition key becomes very hard to change later.`,
    },
  ],
};
