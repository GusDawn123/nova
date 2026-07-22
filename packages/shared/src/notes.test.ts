import { describe, expect, it } from "vitest";

import {
  buildFallbackNotes,
  followUpDraftSchema,
  meetingNotesSchema,
  type MeetingNotes,
} from "./notes.js";

/**
 * Representative accept + reject per contract invariant (not exhaustive — the
 * shape is the contract, the union machinery is zod's). The fallback-parses test
 * is load-bearing: it is the proof the output ladder's last rung can never fail.
 */

/** A fully-populated, schema-valid `generated` notes object used as the accept baseline. */
const validNotes: MeetingNotes = {
  version: 1,
  conversationType: "sales",
  title: "Acme pricing call",
  tldr: "Acme wants a Q3 pilot; pricing to follow.",
  overview: "The buyer walked through their team size and asked for a pilot.",
  decisions: [
    { text: "Proceed with a pilot", quote: "let's do a pilot" },
    { text: "Revisit pricing next week", quote: null, unverified: true },
  ],
  actionItems: [
    {
      text: "Send proposal by Friday",
      owner: "Rep",
      deadline: "2026-07-24",
      deadlineRaw: "by Friday",
      quote: "I'll send the proposal by Friday",
    },
    {
      text: "Loop in legal",
      owner: null,
      deadline: null,
      deadlineRaw: null,
      quote: null,
      unverified: true,
    },
  ],
  openQuestions: ["What is the seat count?"],
  risks: ["Budget not yet approved"],
  typeInsights: {
    kind: "sales",
    objections: ["price too high"],
    buyingSignals: ["asked for a pilot"],
  },
  source: "generated",
};

describe("meetingNotesSchema", () => {
  it("parses a fully-populated valid generated notes object", () => {
    expect(meetingNotesSchema.safeParse(validNotes).success).toBe(true);
  });

  it("rejects a version other than 1", () => {
    const result = meetingNotesSchema.safeParse({ ...validNotes, version: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects an action-item deadline that is not an ISO date", () => {
    const result = meetingNotesSchema.safeParse({
      ...validNotes,
      actionItems: [
        {
          text: "bad deadline",
          owner: null,
          deadline: "next Friday",
          deadlineRaw: "next Friday",
          quote: null,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown typeInsights kind", () => {
    const result = meetingNotesSchema.safeParse({
      ...validNotes,
      typeInsights: { kind: "brainstorm" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra top-level keys", () => {
    const result = meetingNotesSchema.safeParse({
      ...validNotes,
      sentiment: "positive",
    });
    expect(result.success).toBe(false);
  });

  it("accepts the interview and casual typeInsights arms", () => {
    const interview = meetingNotesSchema.safeParse({
      ...validNotes,
      conversationType: "interview",
      typeInsights: {
        kind: "interview",
        questionsAsked: ["Tell me about yourself"],
        answersToRevisit: ["comp expectations"],
      },
    });
    expect(interview.success).toBe(true);

    const casual = meetingNotesSchema.safeParse({
      ...validNotes,
      conversationType: "casual",
      typeInsights: { kind: "casual" },
    });
    expect(casual.success).toBe(true);
  });
});

describe("buildFallbackNotes", () => {
  it("returns a meetingNotesSchema-valid object (the ladder's last rung never fails)", () => {
    const notes = buildFallbackNotes("Weekly sync");
    const result = meetingNotesSchema.safeParse(notes);
    expect(result.success).toBe(true);
    expect(notes.source).toBe("fallback");
    expect(notes.conversationType).toBe("casual");
    expect(notes.typeInsights).toEqual({ kind: "casual" });
    expect(notes.title).toBe("Weekly sync");
    expect(notes.decisions).toEqual([]);
    expect(notes.actionItems).toEqual([]);
    expect(notes.openQuestions).toEqual([]);
    expect(notes.risks).toEqual([]);
  });

  it("stays schema-valid even for an empty/whitespace title", () => {
    for (const title of ["", "   "]) {
      const result = meetingNotesSchema.safeParse(buildFallbackNotes(title));
      expect(result.success).toBe(true);
    }
  });
});

describe("followUpDraftSchema", () => {
  it("parses a valid follow-up draft", () => {
    const result = followUpDraftSchema.safeParse({
      tone: "professional",
      subject: "Great chatting today",
      body: "Thanks for your time — here are the next steps.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown tone", () => {
    const result = followUpDraftSchema.safeParse({
      tone: "snarky",
      subject: "hi",
      body: "there",
    });
    expect(result.success).toBe(false);
  });
});
