import { describe, expect, it } from "vitest";

import { evaluateTrigger } from "./trigger.js";

/**
 * [trigger] The tiered gate fires on labeled trigger moments and stays SILENT in
 * no-op / small-talk windows (the QUIET gate: spam is the #1 uninstall driver).
 * These are the pure-heuristic fixtures; the conductor + live gates layer on top.
 */

/** Hand-labeled small-talk / no-op utterances — the gate MUST stay silent. */
const SMALL_TALK: readonly string[] = [
  "Hey, how are you doing today?",
  "How's it going?",
  "Good morning! Nice to see you again.",
  "Yeah, totally, sounds good to me.",
  "Haha, that's hilarious.",
  "Okay cool, works for me.",
  "How was your weekend?",
  "Nice weather we're having, right?",
  "Alright, talk to you later, take care!",
  "Thanks so much, really appreciate it.",
  "Mhm, for sure, absolutely.",
];

/** Hand-labeled trigger moments — the gate MUST fire, with the labeled kind. */
const TRIGGERS: readonly { text: string; kind: "answer" | "define" | "advance" }[] =
  [
    { text: "What's your approach to handling data consistency?", kind: "answer" },
    { text: "So how did you scale the ingestion pipeline exactly", kind: "answer" },
    { text: "Can you walk me through the architecture", kind: "answer" },
    { text: "I'm curious about your pricing model", kind: "answer" },
    { text: "Tell me about a time you led a difficult project", kind: "answer" },
    { text: "we're building on top of Databricks right now", kind: "define" },
    { text: "mostly did Foundry work at Palantir last summer", kind: "define" },
    {
      text: "last summer i built a real-time trade reconciliation dashboard and wired it into the data warehouse for the automated nightly pulls",
      kind: "advance",
    },
  ];

describe("modules/live [trigger] quiet in no-op windows", () => {
  for (const text of SMALL_TALK) {
    it(`[trigger] stays silent: "${text}"`, () => {
      // Half the time the other party speaks, half the time the user does.
      expect(evaluateTrigger(text, false).fire).toBe(false);
      expect(evaluateTrigger(text, true).fire).toBe(false);
    });
  }
});

describe("modules/live [trigger] fires on labeled moments", () => {
  for (const { text, kind } of TRIGGERS) {
    it(`[trigger] fires ${kind}: "${text.slice(0, 40)}…"`, () => {
      const decision = evaluateTrigger(text, false);
      expect(decision.fire).toBe(true);
      if (decision.fire) expect(decision.kind).toBe(kind);
    });
  }

  it("[trigger] a user's own small talk never advances", () => {
    // A long-but-trivial user utterance is not an advancement cue.
    expect(
      evaluateTrigger("yeah yeah totally okay cool sounds good to me for sure", true)
        .fire,
    ).toBe(false);
  });

  it("[trigger] short fragments never fire", () => {
    expect(evaluateTrigger("uh", false).fire).toBe(false);
    expect(evaluateTrigger("right", false).fire).toBe(false);
  });
});
