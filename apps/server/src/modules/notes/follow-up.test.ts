import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  followUpDraftSchema,
  identifyNotes,
  type FollowUpTone,
  type MeetingNotes,
} from "@nova/shared";

import type {
  ChatMessage,
  ChatRequest,
  LlmRouter,
  LlmStreamEvent,
} from "../llm/index.js";
import { LlmError } from "../llm/index.js";

import { generateFollowUp } from "./follow-up.js";
import type { NotesLogger } from "./ports.js";

/**
 * Follow-up draft generator — Task 5 step 1. Proves: the draft is built ONLY from
 * the notes object (cites-notes-only, asserted MECHANICALLY on the captured prompt
 * against a real Task 3 fixture transcript negative set), the three tones produce
 * distinct register instructions, a content failure falls back to a deterministic
 * notes-summary draft, and a transport failure propagates (the REST layer maps it to
 * a 503 — proven in the route suite).
 */

const NOOP_LOGGER: NotesLogger = { info: () => {}, error: () => {} };

/** A capturing mock router: records every request's messages, replies with `reply`. */
function capturingRouter(reply: string | (() => never)): {
  router: LlmRouter;
  calls: ChatMessage[][];
} {
  const calls: ChatMessage[][] = [];
  const router: LlmRouter = {
    async *stream(req: ChatRequest): AsyncGenerator<LlmStreamEvent> {
      calls.push(req.messages);
      await Promise.resolve(); // async generator: yields on the microtask queue
      // `reply()` returns `never` (it throws — the transport-failure
      // simulation), so this also narrows `reply` to string for the yield.
      const text = typeof reply === "function" ? reply() : reply;
      yield { type: "token", text };
      yield { type: "done", usage: { inputTokens: 12, outputTokens: 7 } };
    },
  };
  return { router, calls };
}

/** Flatten a captured request's message contents into one searchable string. */
function promptText(messages: ChatMessage[]): string {
  return messages.map((m) => m.content).join("\n");
}

/** Notes SUMMARISED from the sales fixture — worded so no transcript line is verbatim. */
const DECISION_TEXT =
  "Recommend the Enterprise plan for SSO and the audit log.";
const ACTION_TEXT = "Send a proposal with the forty-seat Enterprise pricing.";

const SALES_NOTES: MeetingNotes = identifyNotes(
  {
    conversationType: "sales",
    title: "Acme pricing call",
    tldr: "Reviewed pricing tiers and aligned on the Enterprise plan for security needs.",
    overview:
      "The team compared Team, Growth, and Enterprise pricing and concluded Enterprise fit best given the SSO requirement.",
    decisions: [{ text: DECISION_TEXT, quote: null }],
    actionItems: [
      {
        text: ACTION_TEXT,
        owner: "Marcus",
        deadline: "2026-07-24",
        deadlineRaw: "by Friday",
        quote: null,
      },
    ],
    openQuestions: ["Confirm the SOC 2 report scope."],
    risks: ["A full SOC 2 report can take several days via compliance."],
    typeInsights: { kind: "sales", objections: [], buyingSignals: [] },
  },
  "generated",
);

const VALID_REPLY = JSON.stringify({
  subject: "Acme pricing — Enterprise proposal to follow",
  body: "Hi Elena,\n\nThanks for the call. As agreed, Enterprise is the right fit and I'll send the proposal.\n\nBest,\nMarcus",
});

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "notes",
);

const fixtureSchema = z.object({
  turns: z.array(z.object({ text: z.string() })).min(1),
});

function loadSalesTranscriptTexts(): string[] {
  const raw = readFileSync(join(FIXTURE_DIR, "sales.json"), "utf8");
  return fixtureSchema.parse(JSON.parse(raw)).turns.map((t) => t.text);
}

describe("generateFollowUp", () => {
  it("returns a valid draft with the requested tone stamped + usage recorded", async () => {
    const { router } = capturingRouter(VALID_REPLY);
    const run = generateFollowUp({ router, logger: NOOP_LOGGER });

    const result = await run({
      notes: SALES_NOTES,
      tone: "professional",
      meetingTitle: SALES_NOTES.title,
    });

    expect(() => followUpDraftSchema.parse(result.draft)).not.toThrow();
    expect(result.draft.tone).toBe("professional");
    expect(result.draft.subject.length).toBeGreaterThan(0);
    expect(result.fellBack).toBe(false);
    expect(result.usage.length).toBe(1);
    expect(result.usage[0]?.inputTokens).toBe(12);
  });

  it("[cites-notes-only] the captured prompt carries notes strings and NO transcript line", async () => {
    const { router, calls } = capturingRouter(VALID_REPLY);
    const run = generateFollowUp({ router, logger: NOOP_LOGGER });

    await run({
      notes: SALES_NOTES,
      tone: "professional",
      meetingTitle: SALES_NOTES.title,
    });

    const prompt = promptText(calls[0] ?? []);
    // Positive: the prompt IS built from the notes object.
    expect(prompt).toContain(SALES_NOTES.tldr);
    expect(prompt).toContain(DECISION_TEXT);
    expect(prompt).toContain(ACTION_TEXT);
    expect(prompt).toContain("Marcus");

    // Negative: no VERBATIM transcript line from the fixture that produced these
    // notes can appear — the generator's input type admits no transcript, so the
    // prompt is notes-derived by construction.
    for (const turnText of loadSalesTranscriptTexts()) {
      expect(prompt).not.toContain(turnText);
    }
  });

  it("emits distinct register instructions per tone", async () => {
    async function promptFor(tone: FollowUpTone): Promise<string> {
      const { router, calls } = capturingRouter(VALID_REPLY);
      await generateFollowUp({ router, logger: NOOP_LOGGER })({
        notes: SALES_NOTES,
        tone,
        meetingTitle: SALES_NOTES.title,
      });
      return promptText(calls[0] ?? []);
    }

    const professional = await promptFor("professional");
    const warm = await promptFor("warm");
    const brief = await promptFor("brief");

    expect(professional).toContain("TONE: professional");
    expect(warm).toContain("TONE: warm");
    expect(brief).toContain("TONE: brief");
    // The three directives are genuinely different registers, not one template.
    expect(professional).not.toBe(warm);
    expect(warm).not.toBe(brief);
    expect(professional).not.toBe(brief);
  });

  it("falls back to a deterministic notes-summary draft when the ladder exhausts", async () => {
    // Junk on BOTH the generate and repair round-trips → the ladder exhausts.
    const { router } = capturingRouter("not json at all — <<<>>>");
    const run = generateFollowUp({ router, logger: NOOP_LOGGER });

    const result = await run({
      notes: SALES_NOTES,
      tone: "warm",
      meetingTitle: SALES_NOTES.title,
    });

    expect(result.fellBack).toBe(true);
    expect(() => followUpDraftSchema.parse(result.draft)).not.toThrow();
    expect(result.draft.tone).toBe("warm");
    // The fallback draws its content from the notes (cites-notes-only holds here too).
    expect(result.draft.subject).toContain(SALES_NOTES.title);
    expect(result.draft.body).toContain(SALES_NOTES.tldr);
    // Two calls spent (generate + one repair) before the code fallback.
    expect(result.usage.length).toBe(2);
  });

  it("propagates a transport failure (does not swallow LlmError)", async () => {
    const { router } = capturingRouter(() => {
      throw LlmError.transient("provider down");
    });
    const run = generateFollowUp({ router, logger: NOOP_LOGGER });

    await expect(
      run({
        notes: SALES_NOTES,
        tone: "brief",
        meetingTitle: SALES_NOTES.title,
      }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});
