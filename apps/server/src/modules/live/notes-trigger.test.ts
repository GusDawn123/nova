import { describe, expect, it } from "vitest";

import { evaluateNotesTrigger } from "./notes-trigger.js";

/**
 * Gate fixtures in the `trigger.test.ts` style. Remember the economics (§5): this
 * gate sits behind a 25s debounce and is a SMALL-TALK SUPPRESSOR, not the cost
 * control — firing often is correct. The cases that matter most are the quiet
 * ones, and the "buried substance" case, where a false quiet would silently lose
 * real content until the post-call pass.
 */

const turns = (...texts: string[]): { text: string }[] =>
  texts.map((text) => ({ text }));

describe("evaluateNotesTrigger — quiet", () => {
  it("stays quiet on a delta that is nothing but pleasantries", () => {
    const decision = evaluateNotesTrigger(
      turns(
        "Hey, how are you doing today?",
        "Good to see you, it's been a while.",
        "Yeah, all good here thanks.",
      ),
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("small_talk");
  });

  it("stays quiet on a delta with too little substance to be worth a call", () => {
    const decision = evaluateNotesTrigger(turns("Mm.", "Right."));
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("too_short");
  });

  it("stays quiet on substantive-length chatter with no cue at all", () => {
    const decision = evaluateNotesTrigger(
      turns(
        "i mean it just kind of went the way it usually goes you know",
        "yeah pretty much the same as always really",
      ),
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("no_cue");
  });

  it("treats an empty delta as too short, never as an error", () => {
    expect(evaluateNotesTrigger([]).fire).toBe(false);
    expect(evaluateNotesTrigger(turns("", "   ")).fire).toBe(false);
  });
});

describe("evaluateNotesTrigger — fires", () => {
  it.each([
    ["decision_marker", "Okay, we're going with the annual plan then."],
    ["commitment", "I'll send the revised proposal over to your team."],
    ["date_phrase", "Let me get that across to you by end of week."],
    ["numeric", "That comes out at about 4200 for the year."],
    ["negation", "Honestly I'm worried the budget won't stretch that far."],
  ])("fires with reason %s", (reason, text) => {
    const decision = evaluateNotesTrigger(turns(text));
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe(reason);
  });

  it("fires on a question in any turn of the delta", () => {
    const decision = evaluateNotesTrigger(
      turns("Right, that makes sense to me.", "And what does onboarding look like?"),
    );
    expect(decision.fire).toBe(true);
  });

  it("fires on a named entity with no other cue", () => {
    const decision = evaluateNotesTrigger(
      turns("we have been running everything through Snowflake so far"),
    );
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe("proper_noun");
  });

  it("[false-quiet guard] one substantive turn buried in chit-chat still fires", () => {
    // The dangerous failure mode: a real commitment inside a pleasantry window.
    // Every turn must be small talk for the veto to apply — this must NOT skip.
    const decision = evaluateNotesTrigger(
      turns(
        "Hey, good to see you.",
        "How was your weekend?",
        "Good thanks. Oh — I'll get you that contract by Friday.",
        "Nice, thanks!",
      ),
    );
    expect(decision.fire).toBe(true);
  });

  it("is not vetoed by a leading backchannel on a substantive turn", () => {
    const decision = evaluateNotesTrigger(
      turns("Yeah, so we decided to move the launch to March."),
    );
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe("decision_marker");
  });
});
