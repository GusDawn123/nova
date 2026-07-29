import { describe, expect, it } from "vitest";
import { identifyNotes, type MeetingNotes } from "@nova/shared";

import {
  completedItemIds,
  isSameItem,
  type StoredItemState,
} from "./item-completion.js";

/**
 * The completion staleness guard (`docs/DESIGN/notes-ui.md` §6.3). Pure, so no
 * database and no stack env.
 *
 * The cases that matter are the ones a naive "look up by id" implementation gets
 * WRONG: a regenerate that reshuffles which item sits at `a2`, and a reword that
 * should keep the checkmark rather than drop it. Note ids are positional counters,
 * so both happen in normal use.
 */

/** Notes with the given action-item texts, ids minted positionally (a1, a2, …). */
function notesWithItems(...texts: string[]): MeetingNotes {
  return identifyNotes(
    {
      conversationType: "sales",
      title: "Northwind discovery",
      tldr: "Comparing vendors.",
      overview: "Discovery call.",
      decisions: [{ text: "Decide before Aug 5.", quote: null }],
      actionItems: texts.map((text) => ({
        text,
        owner: null,
        deadline: null,
        deadlineRaw: null,
        quote: null,
      })),
      openQuestions: [],
      risks: [],
      typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
    },
    "generated",
  );
}

const CHECKED = "2026-07-28T12:00:00.000Z";

function stored(
  itemId: string,
  itemText: string,
  completedAt: string | null = CHECKED,
): StoredItemState {
  return { itemId, itemText, completedAt };
}

describe("completedItemIds", () => {
  it("returns the ids whose text is unchanged", () => {
    const notes = notesWithItems(
      "Send the scope comparison.",
      "Loop in procurement.",
    );
    const rows = [stored("a1", "Send the scope comparison.")];

    expect(completedItemIds(notes, rows)).toEqual(["a1"]);
  });

  it("keeps the checkmark when a regenerate REWORDED the same item", () => {
    // The post-call pass routinely rephrases a mid-call phrasing. Dropping the
    // check here would make regeneration feel like it erased the user's work.
    const notes = notesWithItems(
      "Send Dana the side-by-side scope comparison.",
    );
    const rows = [stored("a1", "Send the side-by-side scope comparison.")];

    expect(completedItemIds(notes, rows)).toEqual(["a1"]);
  });

  it("DROPS the checkmark when a different item now sits at that id", () => {
    // The failure the whole design exists to prevent. `a1` was "send the scope
    // comparison" when checked; after a regenerate `a1` is an unrelated task. A
    // lookup by id alone would report it done.
    const notes = notesWithItems("Confirm whether SSO is in the pilot scope.");
    const rows = [stored("a1", "Send the scope comparison.")];

    expect(completedItemIds(notes, rows)).toEqual([]);
  });

  it("re-associates by position without leaking across items", () => {
    // Two items swap positions on regenerate. Each id must be judged against the
    // text now at that id — a1's row must not match a2's item.
    const notes = notesWithItems("Loop in procurement.", "Send the comparison.");
    const rows = [
      stored("a1", "Send the comparison."),
      stored("a2", "Loop in procurement."),
    ];

    // a1 now holds "Loop in procurement" but was checked against "Send the
    // comparison", and vice versa — neither survives.
    expect(completedItemIds(notes, rows)).toEqual([]);
  });

  it("ignores rows whose completed_at is null (explicitly unchecked)", () => {
    const notes = notesWithItems("Send the scope comparison.");
    const rows = [stored("a1", "Send the scope comparison.", null)];

    expect(completedItemIds(notes, rows)).toEqual([]);
  });

  it("ignores stored ids that no longer exist at all", () => {
    const notes = notesWithItems("Only one item.");
    const rows = [stored("a1", "Only one item."), stored("a7", "Long gone.")];

    expect(completedItemIds(notes, rows)).toEqual(["a1"]);
  });

  it("considers ONLY action items, never decisions or other lists", () => {
    // The product offers a checkbox on action items alone. A stray `d1` row must
    // not light up a decision the UI never made checkable.
    const notes = notesWithItems("An action.");
    const rows = [stored("d1", "Decide before Aug 5."), stored("a1", "An action.")];

    expect(completedItemIds(notes, rows)).toEqual(["a1"]);
  });

  it("returns ids in the notes' action-item order, not the DB's row order", () => {
    const notes = notesWithItems("First.", "Second.", "Third.");
    const rows = [
      stored("a3", "Third."),
      stored("a1", "First."),
      stored("a2", "Second."),
    ];

    expect(completedItemIds(notes, rows)).toEqual(["a1", "a2", "a3"]);
  });

  it("returns empty for null notes and for no stored rows", () => {
    expect(completedItemIds(null, [stored("a1", "x")])).toEqual([]);
    expect(completedItemIds(notesWithItems("An action."), [])).toEqual([]);
  });

  it("does not match an item whose text was replaced by an empty-ish string", () => {
    // similarity() returns 0 when either word set is empty, so a degenerate text
    // can never clear the threshold by accident.
    const notes = notesWithItems("...");
    const rows = [stored("a1", "Send the scope comparison.")];

    expect(completedItemIds(notes, rows)).toEqual([]);
  });
});

describe("isSameItem", () => {
  it("is true for identical text", () => {
    expect(isSameItem("Send the comparison.", "Send the comparison.")).toBe(
      true,
    );
  });

  it("is insensitive to case and punctuation", () => {
    expect(isSameItem("Send the comparison.", "send the comparison")).toBe(true);
  });

  it("survives a modest addition", () => {
    expect(
      isSameItem("Send the comparison.", "Send the comparison to Dana."),
    ).toBe(true);
  });

  it("is false for two genuinely different tasks", () => {
    expect(
      isSameItem("Send the scope comparison.", "Confirm SSO is in scope."),
    ).toBe(false);
  });

  it("is false when either side has no words", () => {
    expect(isSameItem("", "Send the comparison.")).toBe(false);
    expect(isSameItem("Send the comparison.", "")).toBe(false);
  });
});
