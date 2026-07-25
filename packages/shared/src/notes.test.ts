import { describe, expect, it } from "vitest";

import {
  buildFallbackNotes,
  followUpDraftSchema,
  identifyNotes,
  meetingNotesSchema,
  notesContentSchema,
  storedNotesSchema,
  type MeetingNotes,
  type NotesContent,
} from "./notes.js";

/**
 * Representative accept + reject per contract invariant (not exhaustive — the
 * shape is the contract, the union machinery is zod's). The fallback-parses test
 * is load-bearing: it is the proof the output ladder's last rung can never fail.
 *
 * v2 (live notes, 2026-07-25) splits the contract in two:
 *   - `notesContentSchema` — id-LESS, what the post-call LLM produces. Unchanged
 *     from the v1 body, so no post-call prompt moves.
 *   - `meetingNotesSchema` — v2, IDENTIFIED, what is stored / sent on the wire.
 * `identifyNotes` is the pure bridge; `storedNotesSchema` upcasts stored v1 rows
 * on read so pre-v2 notes keep parsing (the 500-on-every-old-meeting regression).
 */

/** The id-less body the post-call pipeline's ladder validates (v1 body, verbatim). */
const validContent: NotesContent = {
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
};

/** A fully-populated, schema-valid v2 `generated` notes object (the accept baseline). */
const validNotes: MeetingNotes = identifyNotes(validContent, "generated");

describe("notesContentSchema (the post-call LLM contract)", () => {
  it("accepts the id-less body the model produces", () => {
    expect(notesContentSchema.safeParse(validContent).success).toBe(true);
  });

  it("keeps plain-string lists so no post-call prompt has to change", () => {
    const parsed = notesContentSchema.parse(validContent);
    expect(parsed.openQuestions).toEqual(["What is the seat count?"]);
    expect(parsed.risks).toEqual(["Budget not yet approved"]);
  });

  it("rejects an action-item deadline that is not an ISO date", () => {
    const result = notesContentSchema.safeParse({
      ...validContent,
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
    const result = notesContentSchema.safeParse({
      ...validContent,
      typeInsights: { kind: "brainstorm" },
    });
    expect(result.success).toBe(false);
  });
});

describe("identifyNotes", () => {
  it("mints list-prefixed, 1-indexed ids across every itemized list", () => {
    expect(validNotes.decisions.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(validNotes.actionItems.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(validNotes.openQuestions.map((q) => q.id)).toEqual(["q1"]);
    expect(validNotes.risks.map((r) => r.id)).toEqual(["r1"]);
  });

  it("promotes plain-string lists to identified items without losing text", () => {
    expect(validNotes.openQuestions[0]).toEqual({
      id: "q1",
      text: "What is the seat count?",
    });
    expect(validNotes.risks[0]).toEqual({
      id: "r1",
      text: "Budget not yet approved",
    });
  });

  it("identifies the sales insight arms under their own prefixes", () => {
    const insights = validNotes.typeInsights;
    if (insights.kind !== "sales") throw new Error("expected the sales arm");
    expect(insights.objections).toEqual([{ id: "ob1", text: "price too high" }]);
    expect(insights.buyingSignals).toEqual([
      { id: "bs1", text: "asked for a pilot" },
    ]);
  });

  it("is deterministic — the same content always mints the same ids", () => {
    expect(identifyNotes(validContent, "generated")).toEqual(
      identifyNotes(validContent, "generated"),
    );
  });

  it("stamps version 2 and the caller's source", () => {
    expect(validNotes.version).toBe(2);
    expect(validNotes.source).toBe("generated");
    expect(identifyNotes(validContent, "live").source).toBe("live");
  });
});

describe("meetingNotesSchema (v2, the stored + wire shape)", () => {
  it("parses a fully-populated valid generated notes object", () => {
    expect(meetingNotesSchema.safeParse(validNotes).success).toBe(true);
  });

  it("rejects a version other than 2", () => {
    const result = meetingNotesSchema.safeParse({ ...validNotes, version: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects an item that is missing its id", () => {
    const result = meetingNotesSchema.safeParse({
      ...validNotes,
      decisions: [{ text: "no id here", quote: null }],
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

  it("accepts 'live' as a source (the streaming preview marker)", () => {
    const result = meetingNotesSchema.safeParse({
      ...validNotes,
      source: "live",
    });
    expect(result.success).toBe(true);
  });

  it("accepts the interview and casual typeInsights arms", () => {
    const interview = meetingNotesSchema.safeParse(
      identifyNotes(
        {
          ...validContent,
          conversationType: "interview",
          typeInsights: {
            kind: "interview",
            questionsAsked: ["Tell me about yourself"],
            answersToRevisit: ["comp expectations"],
          },
        },
        "generated",
      ),
    );
    expect(interview.success).toBe(true);

    const casual = meetingNotesSchema.safeParse(
      identifyNotes(
        {
          ...validContent,
          conversationType: "casual",
          typeInsights: { kind: "casual" },
        },
        "generated",
      ),
    );
    expect(casual.success).toBe(true);
  });
});

describe("storedNotesSchema (the v1 read boundary)", () => {
  /**
   * A notes object exactly as rows written before 2026-07-25 hold it. This
   * literal must never be "fixed up" to v2 — it is the regression fixture for
   * the bug a bare `version` literal bump would have shipped: every pre-v2
   * meeting's GET would throw on parse and answer 500 for the rest of time.
   */
  const storedV1 = {
    version: 1,
    conversationType: "sales",
    title: "Acme pricing call",
    tldr: "Acme wants a Q3 pilot; pricing to follow.",
    overview: "The buyer walked through their team size and asked for a pilot.",
    decisions: [{ text: "Proceed with a pilot", quote: "let's do a pilot" }],
    actionItems: [
      {
        text: "Send proposal by Friday",
        owner: "Rep",
        deadline: "2026-07-24",
        deadlineRaw: "by Friday",
        quote: "I'll send the proposal by Friday",
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

  it("parses a stored v1 object and upcasts it to v2", () => {
    const parsed = storedNotesSchema.parse(storedV1);
    expect(parsed.version).toBe(2);
  });

  it("mints ids for every v1 item so an old meeting animates like a new one", () => {
    const parsed = storedNotesSchema.parse(storedV1);
    expect(parsed.decisions.map((d) => d.id)).toEqual(["d1"]);
    expect(parsed.actionItems.map((a) => a.id)).toEqual(["a1"]);
    expect(parsed.openQuestions).toEqual([
      { id: "q1", text: "What is the seat count?" },
    ]);
  });

  it("preserves every v1 field value through the upcast", () => {
    const parsed = storedNotesSchema.parse(storedV1);
    expect(parsed.title).toBe(storedV1.title);
    expect(parsed.tldr).toBe(storedV1.tldr);
    expect(parsed.source).toBe("generated");
    expect(parsed.decisions[0]?.quote).toBe("let's do a pilot");
    expect(parsed.actionItems[0]?.deadline).toBe("2026-07-24");
  });

  it("upcasts deterministically — a row read twice yields identical ids", () => {
    expect(storedNotesSchema.parse(storedV1)).toEqual(
      storedNotesSchema.parse(storedV1),
    );
  });

  it("passes a v2 object through unchanged", () => {
    expect(storedNotesSchema.parse(validNotes)).toEqual(validNotes);
  });

  it("still rejects a malformed object under either version", () => {
    expect(storedNotesSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(storedNotesSchema.safeParse({ version: 3 }).success).toBe(false);
  });
});

describe("buildFallbackNotes", () => {
  it("returns a meetingNotesSchema-valid object (the ladder's last rung never fails)", () => {
    const notes = buildFallbackNotes("Weekly sync");
    const result = meetingNotesSchema.safeParse(notes);
    expect(result.success).toBe(true);
    expect(notes.version).toBe(2);
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
