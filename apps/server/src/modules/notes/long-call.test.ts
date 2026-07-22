import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { meetingNotesSchema } from "@nova/shared";

import { createNotesPipeline } from "./pipeline.js";
import type { NotesLogger, NotesMeetingMeta, TranscriptTurn } from "./ports.js";
import { makeNotesRouter } from "./testing/mock-notes-router.js";

/**
 * The long-call bar (playbook VERIFY row 15), mock tier. Runs the pipeline's
 * map-reduce arm over the committed `long-call.json` fixture (a ~90-min transcript
 * with a decision + action item planted in the FIRST ten minutes and DIFFERENT ones
 * in the LAST ten minutes) with a lowered `maxSinglePassTokens` that forces the arm.
 *
 * The mock router READS each chunk it is handed and echoes only the planted facts
 * actually present in that chunk — so the first-chunk fact and the last-chunk fact
 * arrive via SEPARATE map calls. Asserting both survive into the final notes is the
 * boundary-loss proof: nothing about the merge silently drops an early-call fact.
 * (The live-model version of this bar is key-gated in `notes.accuracy.test.ts`.)
 */

const NOOP_LOGGER: NotesLogger = { info: () => {}, error: () => {} };

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "notes",
);

const fixtureSchema = z.object({
  meta: z.object({ title: z.string().min(1), startedAt: z.string().min(1) }),
  turns: z
    .array(
      z.object({
        speaker: z.string().nullable(),
        text: z.string(),
        tsMs: z.number().nullable(),
      }),
    )
    .min(1),
});

const factSchema = z.object({
  decisionKeyword: z.string(),
  decisionQuote: z.string(),
  actionItemKeyword: z.string(),
  actionQuote: z.string(),
  ownerKeyword: z.string(),
  deadlineRawKeyword: z.string(),
});
const manifestSchema = z.object({
  firstFact: factSchema,
  lastFact: factSchema,
});

type Fact = z.infer<typeof factSchema>;

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

/** Build the map-chunk facts a segment yields: only the plants present in it. */
function factsForSegment(segment: string, facts: Fact[]): unknown {
  const decisions: { text: string; quote: string | null }[] = [];
  const actionItems: {
    text: string;
    owner: string | null;
    deadline: string | null;
    deadlineRaw: string | null;
    quote: string | null;
  }[] = [];
  for (const fact of facts) {
    if (segment.includes(fact.decisionQuote)) {
      decisions.push({ text: `Adopt the ${fact.decisionKeyword}`, quote: fact.decisionQuote });
    }
    if (segment.includes(fact.actionQuote)) {
      actionItems.push({
        text: `Send the ${fact.actionItemKeyword}`,
        owner: fact.ownerKeyword,
        deadline: null,
        deadlineRaw: `by ${fact.deadlineRawKeyword}`,
        quote: fact.actionQuote,
      });
    }
  }
  return {
    miniSummary: "A stretch of the renewal call. Terms were discussed. The parties aligned.",
    decisions,
    actionItems,
    openQuestions: [],
    risks: [],
    insights: { objections: [], buyingSignals: [], questionsAsked: [], answersToRevisit: [] },
  };
}

describe("long-call map-reduce (mock) — planted facts survive the boundary", () => {
  it("keeps the first-10-min AND last-10-min facts in the final notes", async () => {
    const fixture = fixtureSchema.parse(readJson("long-call.json"));
    const manifest = manifestSchema.parse(readJson("long-call.expected.json"));
    const facts = [manifest.firstFact, manifest.lastFact];

    const router = makeNotesRouter({ map: (seg) => factsForSegment(seg, facts) });
    // Gate below the fixture's ~21k tokens → the map-reduce arm; default 6k chunks
    // put the two plants in different chunks (they are ~80 minutes apart).
    const pipeline = createNotesPipeline({
      router,
      logger: NOOP_LOGGER,
      config: { maxSinglePassTokens: 4_000 },
    });

    const meta: NotesMeetingMeta = {
      id: "long-call",
      userId: "user-1",
      title: fixture.meta.title,
      startedAt: fixture.meta.startedAt,
    };
    const turns: TranscriptTurn[] = fixture.turns;

    const { notes } = await pipeline.generate(meta, turns);

    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();
    expect(notes.conversationType).toBe("sales");

    // The router split the call into multiple chunks (more than a single map call).
    const mapCalls = router.calls.filter((c) => c.stage === "map").length;
    expect(mapCalls).toBeGreaterThan(1);

    const decisionText = notes.decisions.map((d) => d.text.toLowerCase()).join(" | ");
    expect(decisionText).toContain("enterprise tier"); // first 10 min
    expect(decisionText).toContain("technical onboarding"); // last 10 min

    const firstItem = notes.actionItems.find((a) =>
      a.text.toLowerCase().includes("signed order form"),
    );
    const lastItem = notes.actionItems.find((a) =>
      a.text.toLowerCase().includes("security questionnaire"),
    );
    expect(firstItem, "first-10-min action item must survive").toBeDefined();
    expect(lastItem, "last-10-min action item must survive").toBeDefined();
    expect((firstItem?.owner ?? "").toLowerCase()).toContain("alex");
    expect((lastItem?.owner ?? "").toLowerCase()).toContain("morgan");
    expect((firstItem?.deadlineRaw ?? "").toLowerCase()).toContain("friday");
    expect((lastItem?.deadlineRaw ?? "").toLowerCase()).toContain("wednesday");

    // Both plants quote verbatim transcript lines → they verify (nothing flagged).
    expect(notes.actionItems.every((a) => a.unverified === undefined)).toBe(true);
    expect(notes.decisions.every((d) => d.unverified === undefined)).toBe(true);
  });
});
