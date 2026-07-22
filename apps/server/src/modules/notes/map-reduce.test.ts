import { describe, expect, it } from "vitest";
import { meetingNotesSchema } from "@nova/shared";

import { notesConfigSchema } from "./config.js";
import { runMapReduce } from "./map-reduce.js";
import type { NotesLogger, NotesMeetingMeta, TranscriptTurn } from "./ports.js";
import { joinTranscriptText } from "./verify-quotes.js";
import { makeNotesRouter } from "./testing/mock-notes-router.js";

/**
 * Map-reduce mechanics vs a prompt-READING mock router (`makeNotesRouter`): the map
 * handler echoes only the facts it finds in the segment text it is handed, so a fact
 * planted in the FIRST chunk and one planted in the LAST chunk both have to survive
 * the merge — the boundary-loss guard the design turns on (adr-0006 §5).
 */

const NOOP_LOGGER: NotesLogger = { info: () => {}, error: () => {} };

const META: NotesMeetingMeta = {
  id: "meeting-mr",
  userId: "user-1",
  title: "Quarterly account review",
  startedAt: "2026-07-20T15:00:00Z", // a Monday
};

const FIRST_DECISION = "Let's go with the enterprise tier, that's decided.";
const FIRST_ACTION = "Jordan, please send the signed contract by Monday.";
const LAST_DECISION = "We've decided to schedule the onboarding for next quarter.";
const LAST_ACTION = "Alex, please email the onboarding checklist by Thursday.";

/** ~30 filler turns with the two planted facts near the start and the end. */
function longTurns(): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const filler = (i: number): string =>
    `Speaker ${String(i % 2)} continues the discussion about the account roadmap, timelines, and general logistics in point number ${String(i)}.`;
  for (let i = 0; i < 30; i += 1) {
    let text = filler(i);
    if (i === 1) text = FIRST_DECISION;
    if (i === 2) text = FIRST_ACTION;
    if (i === 27) text = LAST_DECISION;
    if (i === 28) text = LAST_ACTION;
    turns.push({ speaker: i % 2 === 0 ? "Alex" : "Jordan", text, tsMs: i * 3000 });
  }
  return turns;
}

/** A map handler that echoes back only the planted facts present in its segment. */
function echoingMap(seg: string): unknown {
  const facts = {
    miniSummary: "Segment summary sentence one. Sentence two. Sentence three.",
    decisions: [] as { text: string; quote: string | null }[],
    actionItems: [] as {
      text: string;
      owner: string | null;
      deadline: string | null;
      deadlineRaw: string | null;
      quote: string | null;
    }[],
    openQuestions: [] as string[],
    risks: [] as string[],
    insights: {
      objections: [] as string[],
      buyingSignals: [] as string[],
      questionsAsked: [] as string[],
      answersToRevisit: [] as string[],
    },
  };
  if (seg.includes("enterprise tier")) {
    facts.decisions.push({ text: "Go with the enterprise tier", quote: FIRST_DECISION });
    facts.actionItems.push({
      text: "Send the signed contract",
      owner: "Jordan",
      deadline: null,
      deadlineRaw: "by Monday",
      quote: FIRST_ACTION,
    });
  }
  if (seg.includes("schedule the onboarding")) {
    facts.decisions.push({ text: "Schedule onboarding next quarter", quote: LAST_DECISION });
    facts.actionItems.push({
      text: "Email the onboarding checklist",
      owner: "Alex",
      deadline: null,
      deadlineRaw: "by Thursday",
      quote: LAST_ACTION,
    });
  }
  return facts;
}

/** Small budget forces several chunks so the two facts land in different chunks. */
const MR_CONFIG = notesConfigSchema.parse({ mapChunkTokens: 120, mapOverlapRatio: 0.15 });

describe("runMapReduce", () => {
  it("preserves a fact from the FIRST chunk and one from the LAST after merge", async () => {
    const turns = longTurns();
    const router = makeNotesRouter({ map: echoingMap });

    const { notes, usage } = await runMapReduce({
      deps: { router, config: MR_CONFIG, logger: NOOP_LOGGER },
      meta: META,
      turns,
      type: "sales",
      callDate: "2026-07-20",
      weekday: "Monday",
      transcriptText: joinTranscriptText(turns),
    });

    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();

    const actionTexts = notes.actionItems.map((a) => a.text.toLowerCase());
    expect(actionTexts.some((t) => t.includes("signed contract"))).toBe(true); // first chunk
    expect(actionTexts.some((t) => t.includes("onboarding checklist"))).toBe(true); // last chunk
    const decisionTexts = notes.decisions.map((d) => d.text.toLowerCase());
    expect(decisionTexts.some((t) => t.includes("enterprise tier"))).toBe(true);
    expect(decisionTexts.some((t) => t.includes("onboarding"))).toBe(true);

    // Both planted quotes are verbatim transcript lines → they verify (not flagged).
    expect(notes.actionItems.every((a) => a.unverified === undefined)).toBe(true);
    // At least one map call per chunk, plus one reduce, plus one classify-free path
    // (classify happens in the pipeline, not here) → usage spans every model call.
    expect(usage.length).toBeGreaterThan(2);
  });

  it("dedups an action item repeated across overlapping chunks (normalized text)", async () => {
    const turns = longTurns();
    // Every segment claims the SAME action item — the merge must collapse it to one.
    const router = makeNotesRouter({
      map: () => ({
        miniSummary: "One. Two. Three.",
        decisions: [],
        actionItems: [
          {
            text: "Send the   Signed Contract",
            owner: "Jordan",
            deadline: null,
            deadlineRaw: null,
            quote: null,
          },
        ],
        openQuestions: [],
        risks: [],
        insights: { objections: [], buyingSignals: [], questionsAsked: [], answersToRevisit: [] },
      }),
    });

    const { notes } = await runMapReduce({
      deps: { router, config: MR_CONFIG, logger: NOOP_LOGGER },
      meta: META,
      turns,
      type: "sales",
      callDate: "2026-07-20",
      weekday: "Monday",
      transcriptText: joinTranscriptText(turns),
    });

    const contractItems = notes.actionItems.filter((a) =>
      a.text.toLowerCase().includes("signed contract"),
    );
    expect(contractItems).toHaveLength(1);
  });

  it("assembles facts deterministically when the reduce narrative call fails", async () => {
    const turns = longTurns();
    // Reduce returns a schema-invalid object; the repair returns "{}" → the reduce
    // ladder exhausts. Facts must still be assembled around the deterministic narrative.
    const router = makeNotesRouter({
      map: echoingMap,
      reduce: () => ({ not: "valid" }),
    });

    const { notes, rawText } = await runMapReduce({
      deps: { router, config: MR_CONFIG, logger: NOOP_LOGGER },
      meta: META,
      turns,
      type: "sales",
      callDate: "2026-07-20",
      weekday: "Monday",
      transcriptText: joinTranscriptText(turns),
    });

    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();
    expect(notes.source).toBe("generated"); // facts exist → not the empty fallback
    expect(notes.title).toBe(META.title); // deterministic narrative uses the meeting title
    expect(notes.actionItems.some((a) => a.text.toLowerCase().includes("signed contract"))).toBe(true);
    expect(notes.actionItems.some((a) => a.text.toLowerCase().includes("onboarding checklist"))).toBe(true);
    expect(rawText).toBeDefined(); // the failed reduce's raw text is surfaced
  });

  it("never aborts the meeting when a chunk extraction is unsalvageable", async () => {
    const turns = longTurns();
    // Every map call returns junk (invalid on both the first pass and the repair) →
    // every chunk falls back to empty facts, but reduce still yields valid notes.
    const router = makeNotesRouter({ map: () => ({ garbage: true }) });

    const { notes } = await runMapReduce({
      deps: { router, config: MR_CONFIG, logger: NOOP_LOGGER },
      meta: META,
      turns,
      type: "sales",
      callDate: "2026-07-20",
      weekday: "Monday",
      transcriptText: joinTranscriptText(turns),
    });

    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();
    expect(notes.decisions).toEqual([]);
    expect(notes.actionItems).toEqual([]);
  });
});
