import { describe, expect, it } from "vitest";
import { meetingNotesSchema } from "@nova/shared";

import { makeMockProvider } from "../llm/index.js";
import { doneWith, makeRouter, tok } from "../llm/testing/router-harness.js";

import { createNotesPipeline } from "./pipeline.js";
import type { NotesLogger, NotesMeetingMeta, TranscriptTurn } from "./ports.js";
import { makeNotesRouter } from "./testing/mock-notes-router.js";

/**
 * Single-pass pipeline behaviour vs scripted mock providers. The mock consumes one
 * script per `stream()` call, and the pipeline calls the router in order — classify
 * first, then generate, then (only when needed) one repair — so `scripts[0]` is the
 * classify reply, `scripts[1]` the generate reply, `scripts[2]` the repair reply.
 */

const NOOP_LOGGER: NotesLogger = { info: () => {}, error: () => {} };

// 2026-07-22 is a Wednesday; "by Friday" resolves to 2026-07-24.
const META: NotesMeetingMeta = {
  id: "meeting-1",
  userId: "user-1",
  title: "Acme call",
  startedAt: "2026-07-22T15:00:00Z",
};

const TURNS: TranscriptTurn[] = [
  { speaker: "Rep", text: "Thanks for hopping on. Let me walk you through pricing.", tsMs: 0 },
  { speaker: "Buyer", text: "Sounds good. Can you send us a proposal by Friday?", tsMs: 5000 },
  { speaker: "Rep", text: "Absolutely, I'll send the proposal by Friday.", tsMs: 9000 },
];

const SALES_NOTES = {
  conversationType: "sales",
  title: "Acme pricing call",
  tldr: "Discussed pricing; the buyer wants a proposal.",
  overview: "The rep walked the buyer through pricing and agreed to send a written proposal.",
  decisions: [{ text: "Send a proposal", quote: "Can you send us a proposal by Friday?" }],
  actionItems: [
    {
      text: "Send the proposal",
      owner: "Rep",
      deadline: "2026-07-24",
      deadlineRaw: "by Friday",
      quote: "I'll send the proposal by Friday",
    },
  ],
  openQuestions: [],
  risks: [],
  typeInsights: { kind: "sales", objections: [], buyingSignals: ["asked for a proposal"] },
};

const INTERVIEW_NOTES = {
  conversationType: "interview",
  title: "Candidate screen",
  tldr: "Screened a candidate.",
  overview: "Asked the candidate about their background and a design problem.",
  decisions: [],
  actionItems: [],
  openQuestions: ["How deep is their queue experience?"],
  risks: [],
  typeInsights: { kind: "interview", questionsAsked: ["design a queue"], answersToRevisit: [] },
};

const CASUAL_NOTES = {
  conversationType: "casual",
  title: "Catch-up",
  tldr: "Friendly catch-up.",
  overview: "Traded updates; nothing formal decided.",
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  typeInsights: { kind: "casual" },
};

/** A single-provider router that returns each text on successive router calls. */
function pipelineRouter(...texts: string[]) {
  const scripts = texts.map((text) => ({
    events: [tok(text), doneWith({ inputTokens: 10, outputTokens: 5 })],
  }));
  const provider = makeMockProvider("anthropic", scripts);
  const router = makeRouter([provider], { defaultOrder: ["anthropic"] });
  return { router, provider };
}

describe("createNotesPipeline — single pass", () => {
  it("classifies then generates schema-valid, persist-shaped sales notes", async () => {
    const { router, provider } = pipelineRouter("sales", JSON.stringify(SALES_NOTES));
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes, usage } = await pipeline.generate(META, TURNS);

    // Persist-shaped: passes the strict shared schema, stamped generated/v1.
    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();
    expect(notes.source).toBe("generated");
    expect(notes.version).toBe(2);
    expect(notes.conversationType).toBe("sales");
    expect(notes.typeInsights.kind).toBe("sales");
    // The grounded quote verifies (no unverified flag); the dated commitment survives.
    expect(notes.actionItems[0]?.unverified).toBeUndefined();
    expect(notes.actionItems[0]?.owner).toBe("Rep");
    expect(notes.actionItems[0]?.deadline).toBe("2026-07-24");
    // One usage entry per model call: classify + generate.
    expect(usage).toHaveLength(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("puts the transcript at the top, the pinned schema + date + type section at the bottom", async () => {
    const { provider, router } = pipelineRouter("sales", JSON.stringify(SALES_NOTES));
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });
    await pipeline.generate(META, TURNS);

    const genUser = provider.calls[1]?.request.messages[1]?.content ?? "";
    expect(genUser.indexOf("TRANSCRIPT:")).toBeLessThan(
      genUser.indexOf("Return a JSON object"),
    );
    expect(genUser).toContain("send us a proposal by Friday"); // transcript content, at top
    expect(genUser).toContain("Wednesday, 2026-07-22"); // injected call date + weekday
    expect(genUser).toContain("SALES call"); // the type-specific section
    expect(genUser).toContain('"conversationType": "sales"'); // pinned schema literal
  });

  it("selects the interview arm + section for an interview call", async () => {
    const { router, provider } = pipelineRouter(
      "interview",
      JSON.stringify(INTERVIEW_NOTES),
    );
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes } = await pipeline.generate(META, TURNS);
    expect(notes.conversationType).toBe("interview");
    expect(notes.typeInsights.kind).toBe("interview");
    const genUser = provider.calls[1]?.request.messages[1]?.content ?? "";
    expect(genUser).toContain("INTERVIEW");
    expect(genUser).toContain('"kind": "interview"');
  });

  it("degrades an unrecognised classification to casual and still generates", async () => {
    const { router, provider } = pipelineRouter("banana", JSON.stringify(CASUAL_NOTES));
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes } = await pipeline.generate(META, TURNS);
    expect(notes.conversationType).toBe("casual");
    expect(provider.calls[1]?.request.messages[1]?.content).toContain("CASUAL");
  });

  it("captures a repair round-trip in usage (classify + generate + repair)", async () => {
    const { router, provider } = pipelineRouter(
      "sales",
      '{"conversationType":"sales","title":"x"}', // schema-invalid → triggers repair
      JSON.stringify(SALES_NOTES),
    );
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes, usage } = await pipeline.generate(META, TURNS);
    expect(notes.conversationType).toBe("sales");
    expect(usage).toHaveLength(3);
    expect(provider.calls).toHaveLength(3);
  });

  it("falls back (never throws) when generation content is unsalvageable", async () => {
    const { router } = pipelineRouter("sales", "not json", "still not json");
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes } = await pipeline.generate(META, TURNS);
    expect(notes.source).toBe("fallback");
    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();
  });

  it("returns fallback notes for an empty transcript without any model call", async () => {
    const { router, provider } = pipelineRouter("unused");
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes, usage } = await pipeline.generate(META, []);
    expect(notes.source).toBe("fallback");
    expect(usage).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("createNotesPipeline — single-pass ↔ map-reduce gate", () => {
  it("keeps a short transcript single-pass under the default gate", async () => {
    // Prompt-reading router: classify → 'sales', generate → valid sales notes.
    const router = makeNotesRouter({ generate: () => SALES_NOTES });
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes } = await pipeline.generate(META, TURNS);

    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();
    // Exactly the single-pass call sequence — no map/reduce.
    expect(router.calls.map((c) => c.stage)).toEqual(["classify", "generate"]);
  });

  it("forces map-reduce when maxSinglePassTokens is lowered (spy on router stages)", async () => {
    // Same short transcript, but a gate below its estimated size → map-reduce arm.
    const router = makeNotesRouter({});
    const pipeline = createNotesPipeline({
      router,
      logger: NOOP_LOGGER,
      config: { maxSinglePassTokens: 10, mapChunkTokens: 100, mapOverlapRatio: 0.15 },
    });

    const { notes } = await pipeline.generate(META, TURNS);

    expect(() => meetingNotesSchema.parse(notes)).not.toThrow();
    const stages = router.calls.map((c) => c.stage);
    expect(stages[0]).toBe("classify");
    expect(stages).toContain("map");
    expect(stages).toContain("reduce");
    expect(stages).not.toContain("generate"); // never the single-pass call
  });
});

describe("createNotesPipeline — error passthrough", () => {
  it("throws (does not fall back) when generation hits a transport failure", async () => {
    // Classify succeeds; generate's provider dies before any token → LlmError bubbles.
    const classify = makeMockProvider("anthropic", [
      { events: [tok("sales"), doneWith({ inputTokens: 5, outputTokens: 1 })] },
      { failBeforeFirstToken: { kind: "transient" } },
    ]);
    const router = makeRouter([classify], { defaultOrder: ["anthropic"] });
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    await expect(pipeline.generate(META, TURNS)).rejects.toThrow();
  });

  it("degrades to casual when classification itself hits a transport failure", async () => {
    const provider = makeMockProvider("anthropic", [
      { failBeforeFirstToken: { kind: "transient" } }, // classify dies
      { events: [tok(JSON.stringify(CASUAL_NOTES)), doneWith({ inputTokens: 10, outputTokens: 5 })] },
    ]);
    const router = makeRouter([provider], { defaultOrder: ["anthropic"] });
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    const { notes, usage } = await pipeline.generate(META, TURNS);
    expect(notes.conversationType).toBe("casual");
    expect(usage).toHaveLength(1); // classify recorded nothing; only generate
  });
});
