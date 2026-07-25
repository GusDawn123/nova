import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MeetingNotes } from "@nova/shared";

import { llmConfigSchema } from "../llm/config.js";
import {
  createLlmRouter,
  createProvidersFromEnv,
  type LlmProviderEnv,
} from "../llm/index.js";

import { createNotesPipeline } from "./pipeline.js";
import type { NotesLogger, NotesMeetingMeta, TranscriptTurn } from "./ports.js";

/**
 * KEY-GATED live accuracy gate (playbook VERIFY row 14). For each hand-authored
 * fixture (sales / interview / casual) it runs the REAL pipeline through the REAL
 * router over `createProvidersFromEnv`, then asserts the hand-labelled fact
 * manifest: the classified type, fact keywords in the right places, the sales
 * commitment's owner + resolved deadline, three DISTINCT conversationType /
 * typeInsights.kind values, and that every emitted quote verified (no `unverified`
 * flags). Runs ONLY when an LLM key is present (`describe.skipIf`) — exactly like
 * the Phase 2 live smoke and Phase 4 rag accuracy gates — so CI and keyless local
 * runs skip cleanly while the mock suites carry correctness. RUN in Task 6.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

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

const commitmentSchema = z.object({
  textKeyword: z.string(),
  ownerKeyword: z.string(),
  deadline: z.string(),
  deadlineRawKeyword: z.string(),
});

const manifestSchema = z.object({
  sales: z.object({
    expectedType: z.literal("sales"),
    titleKeywords: z.array(z.string()),
    factKeywords: z.array(z.string()),
    commitment: commitmentSchema,
  }),
  interview: z.object({
    expectedType: z.literal("interview"),
    factKeywords: z.array(z.string()),
    minOpenQuestions: z.number().int().nonnegative(),
    requireInsightsNonEmpty: z.boolean(),
  }),
  casual: z.object({
    expectedType: z.literal("casual"),
    factKeywords: z.array(z.string()),
    maxActionItems: z.number().int().nonnegative(),
  }),
});

type Fixture = z.infer<typeof fixtureSchema>;
type Manifest = z.infer<typeof manifestSchema>;
type FixtureName = "sales" | "interview" | "casual";

function loadFixture(name: FixtureName): Fixture {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));
  return fixtureSchema.parse(raw);
}

function loadManifest(): Manifest {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, "expected.json"), "utf8"));
  return manifestSchema.parse(raw);
}

/** Only the keys that are actually set — exactOptionalPropertyTypes-safe. */
function providerEnv(): LlmProviderEnv {
  const env: LlmProviderEnv = {};
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (process.env.GROQ_API_KEY) env.GROQ_API_KEY = process.env.GROQ_API_KEY;
  return env;
}

/** The full searchable text of a notes object (for keyword-presence assertions). */
function notesTextBlob(notes: MeetingNotes): string {
  const parts = [
    notes.title,
    notes.tldr,
    notes.overview,
    ...notes.decisions.map((d) => d.text),
    ...notes.actionItems.map((a) => a.text),
    ...notes.openQuestions.map((q) => q.text),
    ...notes.risks.map((r) => r.text),
  ];
  if (notes.typeInsights.kind === "sales") {
    parts.push(
      ...notes.typeInsights.objections.map((o) => o.text),
      ...notes.typeInsights.buyingSignals.map((b) => b.text),
    );
  } else if (notes.typeInsights.kind === "interview") {
    parts.push(
      ...notes.typeInsights.questionsAsked.map((q) => q.text),
      ...notes.typeInsights.answersToRevisit.map((a) => a.text),
    );
  }
  return parts.join(" ").toLowerCase();
}

function unverifiedCount(notes: MeetingNotes): number {
  const decisions = notes.decisions.filter((d) => d.unverified === true).length;
  const items = notes.actionItems.filter((a) => a.unverified === true).length;
  return decisions + items;
}

const canRun = Boolean(
  process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_API_KEY,
);

describe.skipIf(!canRun)("notes accuracy gate (live)", () => {
  const manifest = loadManifest();
  const results = new Map<FixtureName, MeetingNotes>();

  beforeAll(async () => {
    const providers = createProvidersFromEnv(providerEnv());
    // Generous timeouts for real, long-transcript generations.
    const config = llmConfigSchema.parse({
      ttftTimeoutMs: 30_000,
      stallTimeoutMs: 60_000,
    });
    const router = createLlmRouter({ providers, config });
    const pipeline = createNotesPipeline({ router, logger: NOOP_LOGGER });

    for (const name of ["sales", "interview", "casual"] as const) {
      const fixture = loadFixture(name);
      const meta: NotesMeetingMeta = {
        id: `fixture-${name}`,
        userId: "fixture-user",
        title: fixture.meta.title,
        startedAt: fixture.meta.startedAt,
      };
      const turns: TranscriptTurn[] = fixture.turns;
      const { notes } = await pipeline.generate(meta, turns);
      results.set(name, notes);
    }
  });

  it("classifies the sales call and captures the proposal-by-Friday commitment", () => {
    const notes = results.get("sales");
    expect(notes).toBeDefined();
    if (!notes) return;
    const spec = manifest.sales;

    expect(notes.conversationType).toBe(spec.expectedType);
    expect(notes.typeInsights.kind).toBe(spec.expectedType);

    const title = notes.title.toLowerCase();
    expect(spec.titleKeywords.some((kw) => title.includes(kw))).toBe(true);

    const blob = notesTextBlob(notes);
    for (const kw of spec.factKeywords) {
      expect(blob, `sales notes should mention "${kw}"`).toContain(kw);
    }

    // The named commitment: owner + resolved ISO deadline + verbatim raw phrase.
    const commitment = notes.actionItems.find((item) =>
      item.text.toLowerCase().includes(spec.commitment.textKeyword),
    );
    expect(commitment, "a proposal action item should exist").toBeDefined();
    expect((commitment?.owner ?? "").toLowerCase()).toContain(spec.commitment.ownerKeyword);
    expect(commitment?.deadline).toBe(spec.commitment.deadline);
    expect((commitment?.deadlineRaw ?? "").toLowerCase()).toContain(
      spec.commitment.deadlineRawKeyword,
    );

    expect(unverifiedCount(notes), "every sales quote should verify").toBe(0);
  });

  it("classifies the interview and records questions + open items", () => {
    const notes = results.get("interview");
    expect(notes).toBeDefined();
    if (!notes) return;
    const spec = manifest.interview;

    expect(notes.conversationType).toBe(spec.expectedType);
    expect(notes.typeInsights.kind).toBe(spec.expectedType);

    const blob = notesTextBlob(notes);
    for (const kw of spec.factKeywords) {
      expect(blob, `interview notes should mention "${kw}"`).toContain(kw);
    }

    expect(notes.openQuestions.length).toBeGreaterThanOrEqual(spec.minOpenQuestions);
    if (spec.requireInsightsNonEmpty && notes.typeInsights.kind === "interview") {
      expect(notes.typeInsights.questionsAsked.length).toBeGreaterThan(0);
    }
    expect(unverifiedCount(notes), "every interview quote should verify").toBe(0);
  });

  it("classifies the casual catch-up with at most trivial action items", () => {
    const notes = results.get("casual");
    expect(notes).toBeDefined();
    if (!notes) return;
    const spec = manifest.casual;

    expect(notes.conversationType).toBe(spec.expectedType);
    expect(notes.typeInsights.kind).toBe(spec.expectedType);
    expect(notes.actionItems.length).toBeLessThanOrEqual(spec.maxActionItems);
    expect(unverifiedCount(notes), "every casual quote should verify").toBe(0);
  });

  it("produces three DISTINCT conversation types + insights arms across the fixtures", () => {
    const notesList = [
      results.get("sales"),
      results.get("interview"),
      results.get("casual"),
    ];
    expect(notesList.every((n): n is MeetingNotes => n !== undefined)).toBe(true);
    const types = new Set(notesList.map((n) => n?.conversationType));
    const kinds = new Set(notesList.map((n) => n?.typeInsights.kind));
    expect(types.size).toBe(3);
    expect(kinds.size).toBe(3);
  });
});

/**
 * KEY-GATED live LONG-CALL bar (playbook VERIFY row 15, live tier). Runs the REAL
 * pipeline over the committed ~90-min `long-call.json` fixture with a lowered
 * `maxSinglePassTokens` that forces the MAP-REDUCE arm, then asserts the two planted
 * facts — one in the FIRST ten minutes, one in the LAST — both survive into the
 * final notes (the boundary-loss bar against real models). Skips without an LLM key;
 * RUN in Task 6. The mock-provider version of this bar lives in `long-call.test.ts`.
 */
const longCallManifestSchema = z.object({
  firstFact: z.object({
    decisionKeyword: z.string(),
    actionItemKeyword: z.string(),
    ownerKeyword: z.string(),
    deadlineRawKeyword: z.string(),
  }),
  lastFact: z.object({
    decisionKeyword: z.string(),
    actionItemKeyword: z.string(),
    ownerKeyword: z.string(),
    deadlineRawKeyword: z.string(),
  }),
});

describe.skipIf(!canRun)("notes long-call accuracy gate (live)", () => {
  let notes: MeetingNotes | undefined;
  const manifest = longCallManifestSchema.parse(
    JSON.parse(readFileSync(join(FIXTURE_DIR, "long-call.expected.json"), "utf8")),
  );

  beforeAll(async () => {
    const providers = createProvidersFromEnv(providerEnv());
    const config = llmConfigSchema.parse({
      ttftTimeoutMs: 30_000,
      stallTimeoutMs: 60_000,
    });
    const router = createLlmRouter({ providers, config });
    // Force the map-reduce arm well below the fixture's ~21k tokens.
    const pipeline = createNotesPipeline({
      router,
      logger: NOOP_LOGGER,
      config: { maxSinglePassTokens: 8_000 },
    });

    const fixture = fixtureSchema.parse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, "long-call.json"), "utf8")),
    );
    const meta: NotesMeetingMeta = {
      id: "fixture-long-call",
      userId: "fixture-user",
      title: fixture.meta.title,
      startedAt: fixture.meta.startedAt,
    };
    const result = await pipeline.generate(meta, fixture.turns);
    notes = result.notes;
  });

  it("keeps both the first-10-min and last-10-min planted facts (map-reduce)", () => {
    expect(notes).toBeDefined();
    if (!notes) return;
    const blob = notesTextBlob(notes);
    // First-10-min fact.
    expect(blob, "first-chunk decision keyword").toContain(manifest.firstFact.decisionKeyword);
    expect(blob, "first-chunk action keyword").toContain(manifest.firstFact.actionItemKeyword);
    // Last-10-min fact.
    expect(blob, "last-chunk decision keyword").toContain(manifest.lastFact.decisionKeyword);
    expect(blob, "last-chunk action keyword").toContain(manifest.lastFact.actionItemKeyword);
  });
});
