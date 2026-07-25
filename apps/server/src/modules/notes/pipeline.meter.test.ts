import {
  identifyNotes,
  meetingNotesSchema,
  type NotesContent,
} from "@nova/shared";
import { describe, expect, it, vi } from "vitest";

import type { Meter } from "../llm/index.js";

import { generateFollowUp } from "./follow-up.js";
import { createNotesPipeline } from "./pipeline.js";
import type { NotesLogger, NotesMeetingMeta, TranscriptTurn } from "./ports.js";
import { makeNotesRouter } from "./testing/mock-notes-router.js";

/**
 * [meter] Phase 6 attribution threading (adr-0007 §2): the notes pipeline and the
 * follow-up generator build a per-call meter from the injected `meterFor` factory
 * — stamped with the job's user + meeting — and thread it into EVERY router call
 * (classify, generate, map, reduce, repair). Without the factory (or without ids,
 * for follow-up) calls carry no meter, so existing consumers are untouched.
 */

const NOOP_LOGGER: NotesLogger = { info: () => {}, error: () => {} };

const META: NotesMeetingMeta = {
  id: "meeting-7",
  userId: "user-42",
  title: "Renewal call",
  startedAt: "2026-07-20T10:00:00.000Z",
};

const TURNS: TranscriptTurn[] = [
  { speaker: "Rep", text: "Thanks for making time to talk about the renewal.", tsMs: 0 },
  { speaker: "Customer", text: "Happy to. We are mostly satisfied so far.", tsMs: 4000 },
];

/** A schema-valid single-pass sales notes object the mock generate call returns. */
const SALES_NOTES: NotesContent = {
  conversationType: "sales",
  title: "Renewal call",
  tldr: "Discussed the renewal and agreed on next steps.",
  overview:
    "The rep and the customer reviewed the renewal terms and aligned on the path forward.",
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
};

function fakeMeter(): Meter {
  return { recordUsage: () => undefined };
}

describe("notes pipeline [meter] — meterFor threading", () => {
  it("[meter] every single-pass router call carries the meter built for (userId, meetingId)", async () => {
    const meter = fakeMeter();
    const meterFor = vi.fn(() => meter);
    const router = makeNotesRouter({ generate: () => SALES_NOTES });
    const pipeline = createNotesPipeline({
      router,
      logger: NOOP_LOGGER,
      meterFor,
    });

    await pipeline.generate(META, TURNS);

    expect(meterFor).toHaveBeenCalledWith("user-42", "meeting-7");
    // classify + generate — both calls carry THE per-job meter.
    expect(router.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of router.calls) {
      expect(call.meter).toBe(meter);
    }
  });

  it("[meter] the map-reduce arm threads the meter into map + reduce calls too", async () => {
    const meter = fakeMeter();
    const router = makeNotesRouter({});
    const pipeline = createNotesPipeline({
      router,
      logger: NOOP_LOGGER,
      // Force the long-call arm: everything is over a 1-token single-pass gate.
      config: { maxSinglePassTokens: 1 },
      meterFor: () => meter,
    });

    await pipeline.generate(META, TURNS);

    const stages = router.calls.map((c) => c.stage);
    expect(stages).toContain("map");
    expect(stages).toContain("reduce");
    for (const call of router.calls) {
      expect(call.meter).toBe(meter);
    }
  });

  it("[meter] without meterFor no router call carries a meter (existing consumers untouched)", async () => {
    const router = makeNotesRouter({ generate: () => SALES_NOTES });
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    await pipeline.generate(META, TURNS);

    expect(router.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of router.calls) {
      expect(call.meter).toBeUndefined();
    }
  });
});

describe("follow-up [meter] — meterFor threading", () => {
  // Parsed through the shared schema so the fixture is provably wire-valid (no cast).
  const NOTES = meetingNotesSchema.parse(identifyNotes(SALES_NOTES, "generated"));

  const DRAFT_BODY = {
    subject: "Follow-up: Renewal call",
    body: "Thanks for the call — recapping what we agreed.",
  };

  it("[meter] the follow-up router call carries the meter built for (userId, meetingId)", async () => {
    const meter = fakeMeter();
    const meterFor = vi.fn(() => meter);
    const router = makeNotesRouter({ generate: () => DRAFT_BODY });
    const followUp = generateFollowUp({
      router,
      logger: NOOP_LOGGER,
      meterFor,
    });

    const result = await followUp({
      notes: NOTES,
      tone: "warm",
      meetingTitle: "Renewal call",
      userId: "user-42",
      meetingId: "meeting-7",
    });

    expect(result.fellBack).toBe(false);
    expect(meterFor).toHaveBeenCalledWith("user-42", "meeting-7");
    expect(router.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of router.calls) {
      expect(call.meter).toBe(meter);
    }
  });

  it("[meter] without ids (or without meterFor) the call carries no meter", async () => {
    const meterFor = vi.fn(fakeMeter);
    const router = makeNotesRouter({ generate: () => DRAFT_BODY });
    const followUp = generateFollowUp({
      router,
      logger: NOOP_LOGGER,
      meterFor,
    });

    await followUp({
      notes: NOTES,
      tone: "warm",
      meetingTitle: "Renewal call",
    });

    expect(meterFor).not.toHaveBeenCalled();
    for (const call of router.calls) {
      expect(call.meter).toBeUndefined();
    }
  });
});
