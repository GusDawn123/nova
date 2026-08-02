import { describe, expect, it } from "vitest";
import { identifyNotes, type MeetingNotes } from "@nova/shared";

import type { NoteItemStateStore } from "../../db/note-item-state.js";

import { readCompletedIds } from "./item-completion-routes.js";
import type { StoredItemState } from "./item-completion.js";
import type { NotesLogger } from "./ports.js";

/**
 * `readCompletedIds` — the BEST-EFFORT read the notes GET composes in. Pure enough
 * to unit-test: the only I/O is the injected store, so a stub covers every branch
 * without a database.
 *
 * The branch worth the file is the failing store. Completion is an accent on a
 * checkbox; an outage in that one table must not turn a perfectly good notes read
 * into a 500 — and it must not degrade in silence either, or a permanently broken
 * table reads to everyone as "nothing is checked".
 */

/** Notes carrying the given action-item texts, ids minted positionally (a1, a2, …). */
function notesWithItems(texts: readonly string[]): MeetingNotes {
  return identifyNotes(
    {
      conversationType: "sales",
      title: "Northwind discovery",
      tldr: "Comparing three vendors.",
      overview: "Discovery call covering budget and timeline.",
      decisions: [],
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

interface CapturedLog {
  fields: Record<string, unknown>;
  msg: string;
}
function capturingLogger(): { logger: NotesLogger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  return {
    lines,
    logger: {
      info: (fields, msg) => lines.push({ fields, msg }),
      error: (fields, msg) => lines.push({ fields, msg }),
    },
  };
}

/** A store that answers with fixed rows; `setCompleted` is never exercised here. */
function storeReturning(rows: StoredItemState[]): NoteItemStateStore {
  return {
    readForMeeting: () => Promise.resolve(rows),
    setCompleted: () => Promise.reject(new Error("not exercised by this test")),
  };
}

/** A store whose read rejects — the outage case. */
function brokenStore(message: string): NoteItemStateStore {
  return {
    readForMeeting: () => Promise.reject(new Error(message)),
    setCompleted: () => Promise.reject(new Error("not exercised by this test")),
  };
}

const MEETING_ID = "0d1b2f18-3b1a-4a2f-9f0e-2f6a5c3d4e5b";
const USER_ID = "8c7b6a59-4d3e-2f1a-9b8c-7d6e5f4a3b2c";
const REQUEST_ID = "req-item-completion-1";

describe("readCompletedIds", () => {
  it("returns the ids whose stored text still matches the rendered notes", async () => {
    const log = capturingLogger();
    const ids = await readCompletedIds(
      storeReturning([
        {
          itemId: "a1",
          itemText: "Send the comparison.",
          completedAt: "2026-07-28T12:00:00.000Z",
        },
      ]),
      notesWithItems(["Send the comparison.", "Loop in ops."]),
      MEETING_ID,
      USER_ID,
      REQUEST_ID,
      log.logger,
    );

    expect(ids).toEqual(["a1"]);
    expect(log.lines).toEqual([]);
  });

  it("returns [] and LOGS when the store fails", async () => {
    // Unchecked is the safe direction: the user sees their task as outstanding
    // rather than being told they finished something they did not.
    const log = capturingLogger();
    const ids = await readCompletedIds(
      brokenStore("note_item_state read failed"),
      notesWithItems(["Send the comparison."]),
      MEETING_ID,
      USER_ID,
      REQUEST_ID,
      log.logger,
    );

    expect(ids).toEqual([]);
    expect(log.lines).toHaveLength(1);
    const line = log.lines[0];
    expect(line?.msg).toBe("notes.routes.item_completion_read_failed");
    expect(line?.fields).toMatchObject({
      request_id: REQUEST_ID,
      user_id: USER_ID,
      meeting_id: MEETING_ID,
      error: "note_item_state read failed",
    });
    // Ids and the error only — never the notes the read was for (RULES §10).
    expect(JSON.stringify(line?.fields)).not.toContain("Send the comparison");
  });

  it("returns [] with NO log when the store is unwired", async () => {
    // The DB-less boot posture is a configuration, not an outage: logging it on
    // every read would bury the line that means something.
    const log = capturingLogger();
    const ids = await readCompletedIds(
      undefined,
      notesWithItems(["Send the comparison."]),
      MEETING_ID,
      USER_ID,
      REQUEST_ID,
      log.logger,
    );

    expect(ids).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it("returns [] without touching the store when nothing renders", async () => {
    // No notes and no live preview: there is no item to resolve a checkmark
    // against, so the query is skipped entirely rather than answered and discarded.
    const log = capturingLogger();
    const ids = await readCompletedIds(
      brokenStore("would have been read"),
      null,
      MEETING_ID,
      USER_ID,
      REQUEST_ID,
      log.logger,
    );

    expect(ids).toEqual([]);
    expect(log.lines).toEqual([]);
  });
});
