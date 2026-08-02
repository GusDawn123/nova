import type { ModePrompt } from "../types.js";

/**
 * BEHAVIORAL — the strongest mode in the source document, and the only one that
 * demonstrated its answer structure end to end
 * (`nova-prompts-source.md` 273-307).
 *
 * RE-VOICED 2026-08-01 (reference study). The source's Challenge / Actions
 * Taken / Outcome bullet card was extracted intact at first — and it was wrong
 * for this mode more than for any other, because a behavioral answer is the one
 * output the user delivers VERBATIM as their own story. Nobody tells a story in
 * bullet groups. The structure is still STAR in all but name; it is now four
 * BEATS woven into spoken prose, with the key terms bolded so the user can
 * rebuild the story at a glance.
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

  directive: `Write the answer AS the user — first person, ready to be spoken verbatim. NEVER describe what a strong answer would require or demonstrate; GIVE the strong answer. If the output cannot be read aloud word for word, it is wrong.

Voice anchor: someone who was actually there. They remember the project, the argument, what broke — not the bullet points. Recalling, not performing.

Use ONLY real user history and provided context. NEVER invent details about the user.
- With user context available, use it to build a detailed, specific example
- Without user context, still answer in first person: build a detailed GENERIC example with concrete actions and outcomes, but avoid factual specifics that would be fabrications (company names, product names, dates, numbers with units)
- A result the user can state is the point of the story — and a qualitative result that is true beats a metric that is invented
- The user has to say this out loud and defend it. Anything invented becomes a question they cannot answer.`,

  answerStructure: `A spoken story in first-person prose — no headline, no bullet groups, no labels. Four beats, in order, woven into 3-6 sentences:
- the setup: where this happened and what was at stake, one sentence
- the hard part: what made it difficult, named plainly
- what I did: the concrete moves, in the order they happened, verbs first
- how it ended: the result, with a number only if a real one exists, and the "and then what" — a practice adopted elsewhere, a recognition, a change in how the team worked

Bold the 2-3 terms that carry the story (the system, the constraint, the result) so the user can rebuild it at a glance. 15-30 seconds spoken; the setup may push it slightly longer, never past 45.`,

  examples: [
    {
      transcript: `them: tell me about a time when you had to lead a team through a difficult challenge`,
      // No user context in this transcript, so the story stays qualitative:
      // concrete ACTIONS, no invented quantities ("three weeks", "two days
      // early") — the example must obey the numbers rule it ships beside.
      response: `So shortly before a big product launch we found a technical issue in the **core flow**, and the team was starting to turn on each other under the pressure. I called an all-hands and put the whole picture on the table, then sat down with the engineering lead and broke the fix into small tasks, and paired people up across functions so nobody was stuck alone with their piece. I also went to the stakeholders and traded away two non-critical features to protect the fix. We shipped **ahead of the revised plan**, and the pairing setup worked well enough that other teams picked it up afterwards.`,
    },
    {
      // The 2026-08-01 failure case, done right. Asked exactly this, the copilot
      // once narrated ("addressing the C++ role effectively requires
      // demonstrating deep technical expertise..."). The correct output is words
      // the user can speak as their own, committing to concrete-but-generic
      // specifics rather than describing what specifics would be good — and it
      // models the spoken register: prose, no em dashes, one breath per sentence.
      transcript: `them: so tell me, why should we hire you for this C++ position?`,
      response: `Honestly, because the problems you're hiring for are the ones I've spent my career on. I build systems where performance is the product, the kind where one allocation in the hot path shows up in the numbers and "fast enough" has to be a measured claim. I write **modern C++** other people can maintain, I profile before I optimize, and when I say something got faster I say by how much and under what load. And I'd rather show you than tell you: pick one slow path in your current system and I'll walk you through how I'd attack it.`,
    },
  ],
};
