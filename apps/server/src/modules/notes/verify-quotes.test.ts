import { describe, expect, it } from "vitest";
import {
  FALLBACK_TLDR,
  identifyNotes,
  type MeetingNotes,
  type NotesContent,
} from "@nova/shared";

import { joinTranscriptText, normalizeForMatch, verifyNotes } from "./verify-quotes.js";

/**
 * Quote/deadline guards vs hand-picked edge cases. The transcript corpus is a
 * single string; each case tweaks one item's quote or deadline and asserts the
 * flag (never a drop) or the invented-date nulling.
 */

const TRANSCRIPT =
  "Alice: Let's ship the beta on Monday.\nBob: I'll send the proposal by Friday.";

/**
 * A generated-shaped notes object with the given decisions/actionItems spliced in.
 * Takes id-LESS content and mints ids via `identifyNotes` (v2) so each case reads as
 * the facts under test, not as id bookkeeping.
 */
function notesWith(
  overrides: Partial<Pick<NotesContent, "decisions" | "actionItems">>,
): MeetingNotes {
  return identifyNotes(
    {
      conversationType: "casual",
      title: "Test call",
      tldr: FALLBACK_TLDR,
      overview: FALLBACK_TLDR,
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: [],
      typeInsights: { kind: "casual" },
      ...overrides,
    },
    "generated",
  );
}

describe("verifyNotes — quote grounding", () => {
  it("keeps a decision whose quote is a verbatim transcript substring (no flag)", () => {
    const notes = notesWith({
      decisions: [{ text: "Ship the beta Monday", quote: "ship the beta on Monday" }],
    });
    const out = verifyNotes(notes, TRANSCRIPT);
    expect(out.decisions[0]?.unverified).toBeUndefined();
  });

  it("tolerates case differences and curly apostrophes without flagging", () => {
    const notes = notesWith({
      actionItems: [
        {
          text: "Send proposal",
          owner: "Bob",
          deadline: null,
          deadlineRaw: "by Friday",
          // Curly apostrophe + different casing vs the straight-quote transcript.
          quote: "I’LL send the proposal by friday",
        },
      ],
    });
    const out = verifyNotes(notes, TRANSCRIPT);
    expect(out.actionItems[0]?.unverified).toBeUndefined();
  });

  it("flags (never drops) a decision whose quote is absent from the transcript", () => {
    const notes = notesWith({
      decisions: [{ text: "Invented decision", quote: "we agreed to acquire the company" }],
    });
    const out = verifyNotes(notes, TRANSCRIPT);
    expect(out.decisions).toHaveLength(1); // kept for recall
    expect(out.decisions[0]?.unverified).toBe(true);
  });

  it("never flags a null quote (no evidence claimed)", () => {
    const notes = notesWith({
      decisions: [{ text: "Some decision", quote: null }],
    });
    const out = verifyNotes(notes, TRANSCRIPT);
    expect(out.decisions[0]?.unverified).toBeUndefined();
  });
});

describe("verifyNotes — invented-date guard", () => {
  it("nulls both deadline and deadlineRaw when a date has no verbatim source phrase", () => {
    const notes = notesWith({
      actionItems: [
        {
          text: "Do the thing",
          owner: "Alice",
          deadline: "2026-07-24", // resolved ISO...
          deadlineRaw: null, // ...but no phrase was ever stated → invented
          quote: null,
        },
      ],
    });
    const out = verifyNotes(notes, TRANSCRIPT);
    expect(out.actionItems[0]?.deadline).toBeNull();
    expect(out.actionItems[0]?.deadlineRaw).toBeNull();
  });

  it("keeps a deadline that carries its verbatim source phrase", () => {
    const notes = notesWith({
      actionItems: [
        {
          text: "Send proposal",
          owner: "Bob",
          deadline: "2026-07-24",
          deadlineRaw: "by Friday",
          quote: "send the proposal by Friday",
        },
      ],
    });
    const out = verifyNotes(notes, TRANSCRIPT);
    expect(out.actionItems[0]?.deadline).toBe("2026-07-24");
    expect(out.actionItems[0]?.deadlineRaw).toBe("by Friday");
  });
});

describe("normalization helpers", () => {
  it("joins turn texts into one corpus", () => {
    expect(joinTranscriptText([{ text: "one" }, { text: "two" }])).toBe("one two");
  });

  it("collapses whitespace, folds case, and straightens curly quotes", () => {
    expect(normalizeForMatch("  It’S   Fine\n\tHere ")).toBe("it's fine here");
  });
});
