import { describe, expect, it } from "vitest";
import { identifyNotes, type MeetingNotes } from "@nova/shared";

import type { MeetingListRow } from "./ports.js";
import { toListItem, toListItems } from "./project.js";

/**
 * The row→card projection (`docs/DESIGN/notes-ui.md` §6.1). Pure, so this suite
 * needs no database and no stack env — it runs everywhere `npm run test` runs.
 *
 * The cases that matter are the FALLBACK RULES: which fields fall back to the live
 * preview when post-call notes have not landed, and — the part that is easy to get
 * wrong later — which deliberately do not.
 */

/** Post-call notes: two action items, a sales classification, a settled tldr. */
const FINAL_NOTES: MeetingNotes = identifyNotes(
  {
    conversationType: "sales",
    title: "Northwind discovery",
    tldr: "Northwind is comparing three vendors with $40k left this quarter.",
    overview: "Discovery call covering budget, timeline and procurement.",
    decisions: [{ text: "Decide before procurement closes.", quote: null }],
    actionItems: [
      {
        text: "Send the scope comparison.",
        owner: "You",
        deadline: null,
        deadlineRaw: "Thursday",
        quote: null,
      },
      {
        text: "Loop in procurement.",
        owner: "Dana",
        deadline: null,
        deadlineRaw: null,
        quote: null,
      },
    ],
    openQuestions: ["Who signs?"],
    risks: [],
    typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
  },
  "generated",
);

/**
 * The LIVE preview of the same call, mid-fold: a different (provisional) tldr, a
 * different classification, and a different number of action items. Every field
 * differs from FINAL_NOTES on purpose so a wrong fallback is visible, not lucky.
 */
const LIVE_NOTES: MeetingNotes = identifyNotes(
  {
    conversationType: "interview",
    title: "Northwind discovery",
    tldr: "Budget and timeline discussed so far.",
    overview: "In progress.",
    decisions: [],
    actionItems: [
      {
        text: "Send something.",
        owner: null,
        deadline: null,
        deadlineRaw: null,
        quote: null,
      },
    ],
    openQuestions: [],
    risks: [],
    typeInsights: {
      kind: "interview",
      questionsAsked: [],
      answersToRevisit: [],
    },
  },
  "live",
);

/** A row with everything null/absent; each case overrides only what it tests. */
function row(overrides: Partial<MeetingListRow> = {}): MeetingListRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Northwind discovery",
    startedAt: "2026-07-22T12:40:00.000Z",
    endedAt: "2026-07-22T13:14:00.000Z",
    notesStatus: "none",
    notes: null,
    liveNotes: null,
    hasFollowUp: false,
    ...overrides,
  };
}

describe("toListItem", () => {
  it("carries the plain columns through untouched", () => {
    const item = toListItem(
      row({ notesStatus: "processing", hasFollowUp: true }),
    );

    expect(item.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(item.title).toBe("Northwind discovery");
    expect(item.started_at).toBe("2026-07-22T12:40:00.000Z");
    expect(item.ended_at).toBe("2026-07-22T13:14:00.000Z");
    expect(item.notes_status).toBe("processing");
    expect(item.has_follow_up).toBe(true);
  });

  it("prefers post-call notes for every derived field", () => {
    const item = toListItem(
      row({ notes: FINAL_NOTES, liveNotes: LIVE_NOTES, notesStatus: "completed" }),
    );

    expect(item.tldr).toBe(FINAL_NOTES.tldr);
    expect(item.conversation_type).toBe("sales");
    expect(item.action_item_count).toBe(2);
  });

  it("falls back to the live tldr while the pipeline is still running", () => {
    // The case the design leans on: a "Writing notes" card would otherwise show a
    // blank summary at the exact moment the user is most curious about the call.
    const item = toListItem(
      row({ notes: null, liveNotes: LIVE_NOTES, notesStatus: "processing" }),
    );

    expect(item.tldr).toBe("Budget and timeline discussed so far.");
  });

  it("does NOT fall back for conversation type or the action-item count", () => {
    // Deliberate asymmetry, not an oversight. The live fold revises both as the
    // call goes on; a chip that reads "interview" and later flips to "sales", or a
    // count that ticks 2 -> 4 -> 3, presents a moving value as a settled one. Prose
    // reads as provisional under a "Writing notes" badge; a chip does not.
    const item = toListItem(row({ notes: null, liveNotes: LIVE_NOTES }));

    expect(item.tldr).toBe("Budget and timeline discussed so far.");
    expect(item.conversation_type).toBeNull();
    expect(item.action_item_count).toBe(0);
  });

  it("yields nulls and a zero count when there are no notes at all", () => {
    const item = toListItem(row());

    expect(item.tldr).toBeNull();
    expect(item.conversation_type).toBeNull();
    expect(item.action_item_count).toBe(0);
  });

  it("tolerates a null started_at / ended_at (created but never connected)", () => {
    const item = toListItem(row({ startedAt: null, endedAt: null }));

    expect(item.started_at).toBeNull();
    expect(item.ended_at).toBeNull();
  });

  it("counts zero action items without inventing one", () => {
    const empty: MeetingNotes = { ...FINAL_NOTES, actionItems: [] };
    expect(toListItem(row({ notes: empty })).action_item_count).toBe(0);
  });
});

describe("toListItems", () => {
  it("preserves the reader's order and never re-sorts", () => {
    const ids = ["a", "b", "c"].map(
      (c) => `${c.repeat(8)}-1111-4111-8111-111111111111`,
    );
    const rows = ids.map((id) => row({ id }));

    expect(toListItems(rows).map((i) => i.id)).toEqual(ids);
  });

  it("returns an empty page for an empty read", () => {
    expect(toListItems([])).toEqual([]);
  });
});
