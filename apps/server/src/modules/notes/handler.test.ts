import { describe, expect, it, vi } from "vitest";
import {
  buildFallbackNotes,
  identifyNotes,
  type MeetingNotes,
} from "@nova/shared";

import type { ClaimedJob, JobUsage } from "../../db/jobs.js";
import type { LiveNotesStore } from "../../db/live-notes.js";
import { LlmError } from "../llm/index.js";

import { createNotesJobHandler } from "./handler.js";
import type {
  NotesLogger,
  NotesPipeline,
  NotesSource,
  NotesSourceMeeting,
  NotesWriter,
  TranscriptTurn,
} from "./ports.js";

/**
 * Handler error-mapping vs fakes for the three seams (source / pipeline / writer).
 * Proves the discriminated outcome the worker keys its store transition off:
 * completed on success, failed on a missing meeting, completed no-op on a deleted
 * one, retry on transport + unexpected errors.
 */

const NOOP_LOGGER: NotesLogger = { info: () => {}, error: () => {} };

const JOB: ClaimedJob = {
  id: "job-1",
  kind: "generate_notes",
  meetingId: "meeting-1",
  userId: "user-1",
  attempts: 1,
  maxAttempts: 5,
};

const MEETING: NotesSourceMeeting = {
  id: "meeting-1",
  userId: "user-1",
  title: "Acme call",
  startedAt: "2026-07-22T15:00:00Z",
  deletedAt: null,
};

const TURNS: TranscriptTurn[] = [{ speaker: "Rep", text: "hello", tsMs: 0 }];
const NOTES: MeetingNotes = buildFallbackNotes("Acme call");
const USAGE: JobUsage[] = [{ inputTokens: 10, outputTokens: 5 }];

/** A source with overridable behaviour per test. */
function fakeSource(over: Partial<NotesSource> = {}): NotesSource {
  return {
    loadMeeting: over.loadMeeting ?? (() => Promise.resolve(MEETING)),
    loadTranscript: over.loadTranscript ?? (() => Promise.resolve(TURNS)),
  };
}

function fakePipeline(
  generate: NotesPipeline["generate"] = () =>
    Promise.resolve({ notes: NOTES, usage: USAGE }),
): NotesPipeline {
  return { generate };
}

/** A live-notes store that answers with `notes`, or throws when given an Error. */
function fakeLiveNotes(seed: MeetingNotes | Error | null): LiveNotesStore {
  return {
    readLiveNotes: () =>
      seed instanceof Error
        ? Promise.reject(seed)
        : Promise.resolve(
            seed === null
              ? null
              : { notes: seed, rev: 3, updatedAt: "2026-07-22T15:30:00Z" },
          ),
    upsertLiveNotes: () => Promise.resolve({ status: "written", rev: 1 }),
  };
}

/** Notes carrying one risk, so id carry-over is observable. */
function notesWithRisk(
  text: string,
  source: "generated" | "live",
): MeetingNotes {
  return identifyNotes(
    {
      conversationType: "casual",
      title: "Acme call",
      tldr: "A call happened.",
      overview: "Things were said on the call.",
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: [text],
      typeInsights: { kind: "casual" },
    },
    source,
  );
}

describe("createNotesJobHandler — live-notes reconciliation (Phase 8 §3)", () => {
  it("carries live ids onto the matching final items before the write", async () => {
    const writeNotes = vi.fn<NotesWriter["writeNotes"]>(() =>
      Promise.resolve(),
    );
    // The live preview minted r1 for this risk during the call…
    const live = notesWithRisk("Budget freeze", "live");
    // …and the post-call pass re-derived it, freshly id'd as r1 too — but only
    // because it is the sole item. Seed a SECOND live item so the carried id is
    // r2, which a naive fresh mint would never produce.
    const liveTwo: MeetingNotes = {
      ...live,
      risks: [
        { id: "r1", text: "Something dropped from the final notes" },
        { id: "r2", text: "Budget freeze" },
      ],
    };
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(() =>
        Promise.resolve({
          notes: notesWithRisk("Budget freeze", "generated"),
          usage: USAGE,
        }),
      ),
      source: fakeSource(),
      writer: { writeNotes },
      logger: NOOP_LOGGER,
      liveNotes: fakeLiveNotes(liveTwo),
    });

    await handler.handle(JOB);

    const written = writeNotes.mock.calls[0]?.[2];
    expect(written?.risks).toEqual([{ id: "r2", text: "Budget freeze" }]);
    // The FINAL notes are still what gets written — reconcile only rewrites ids.
    expect(written?.source).toBe("generated");
  });

  it("writes unreconciled notes when there is no live preview", async () => {
    const writeNotes = vi.fn(() => Promise.resolve());
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(),
      source: fakeSource(),
      writer: { writeNotes },
      logger: NOOP_LOGGER,
      liveNotes: fakeLiveNotes(null),
    });

    const outcome = await handler.handle(JOB);
    expect(outcome).toEqual({ outcome: "completed", usage: USAGE });
    expect(writeNotes).toHaveBeenCalledWith(
      "meeting-1",
      "user-1",
      NOTES,
      expect.any(Date),
    );
  });

  it("[best-effort] a live-notes read failure still completes the job", async () => {
    // The animation is cosmetic; the notes write behind it is not. A live-notes
    // outage must never turn a successful generation into a retry.
    const writeNotes = vi.fn(() => Promise.resolve());
    const error = vi.fn();
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(),
      source: fakeSource(),
      writer: { writeNotes },
      logger: { info: () => {}, error },
      liveNotes: fakeLiveNotes(new Error("live_notes unavailable")),
    });

    const outcome = await handler.handle(JOB);

    expect(outcome).toEqual({ outcome: "completed", usage: USAGE });
    expect(writeNotes).toHaveBeenCalledWith(
      "meeting-1",
      "user-1",
      NOTES,
      expect.any(Date),
    );
    expect(error.mock.calls[0]?.[1]).toBe(
      "notes.handler.live_notes_read_failed",
    );
  });
});

describe("createNotesJobHandler", () => {
  it("loads → generates → writes → completed with usage", async () => {
    const writeNotes = vi.fn(() => Promise.resolve());
    const writer: NotesWriter = { writeNotes };
    const generate = vi.fn<NotesPipeline["generate"]>(() =>
      Promise.resolve({ notes: NOTES, usage: USAGE }),
    );
    const now = (): Date => new Date("2026-07-22T16:00:00Z");
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(generate),
      source: fakeSource(),
      writer,
      logger: NOOP_LOGGER,
      now,
    });

    const outcome = await handler.handle(JOB);

    expect(outcome).toEqual({ outcome: "completed", usage: USAGE });
    // The pipeline saw the loaded meta + turns.
    expect(generate.mock.calls[0]?.[0].id).toBe("meeting-1");
    // The writer persisted notes with the injected generatedAt (user-scoped write).
    expect(writeNotes).toHaveBeenCalledWith(
      "meeting-1",
      "user-1",
      NOTES,
      new Date("2026-07-22T16:00:00Z"),
    );
  });

  it("logs one per-user usage line summing usage[] on completion (Phase 6 metering seam)", async () => {
    // Two model calls (classify + generate) — the log must SUM them, not count 1.
    const multiUsage: JobUsage[] = [
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 40, outputTokens: 15 },
    ];
    const info = vi.fn();
    const logger: NotesLogger = { info, error: () => {} };
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(() =>
        Promise.resolve({ notes: NOTES, usage: multiUsage }),
      ),
      source: fakeSource(),
      writer: { writeNotes: () => Promise.resolve() },
      logger,
    });

    await handler.handle(JOB);

    const completed = info.mock.calls.find(
      (call) => call[1] === "notes.handler.completed",
    );
    expect(completed).toBeDefined();
    expect(completed?.[0]).toEqual(
      expect.objectContaining({
        job_id: "job-1",
        meeting_id: "meeting-1",
        user_id: "user-1",
        input_tokens: 140,
        output_tokens: 35,
        calls: 2,
      }),
    );
  });

  it("fails terminally when the meeting row is missing", async () => {
    const writeNotes = vi.fn(() => Promise.resolve());
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(),
      source: fakeSource({ loadMeeting: () => Promise.resolve(null) }),
      writer: { writeNotes },
      logger: NOOP_LOGGER,
    });

    const outcome = await handler.handle(JOB);
    expect(outcome.outcome).toBe("failed");
    expect(writeNotes).not.toHaveBeenCalled();
  });

  it("completes as a no-op for a soft-deleted meeting (no write)", async () => {
    const writeNotes = vi.fn(() => Promise.resolve());
    const generate = vi.fn(() =>
      Promise.resolve({ notes: NOTES, usage: USAGE }),
    );
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(generate),
      source: fakeSource({
        loadMeeting: () =>
          Promise.resolve({ ...MEETING, deletedAt: "2026-07-22T15:30:00Z" }),
      }),
      writer: { writeNotes },
      logger: NOOP_LOGGER,
    });

    const outcome = await handler.handle(JOB);
    expect(outcome).toEqual({ outcome: "completed", usage: [] });
    expect(generate).not.toHaveBeenCalled();
    expect(writeNotes).not.toHaveBeenCalled();
  });

  it("retries when generation hits a transport failure", async () => {
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(() => Promise.reject(LlmError.transient("down"))),
      source: fakeSource(),
      writer: { writeNotes: () => Promise.resolve() },
      logger: NOOP_LOGGER,
    });

    const outcome = await handler.handle(JOB);
    expect(outcome.outcome).toBe("retry");
  });

  it("retries conservatively when the notes write throws (DB blip)", async () => {
    const handler = createNotesJobHandler({
      pipeline: fakePipeline(),
      source: fakeSource(),
      writer: { writeNotes: () => Promise.reject(new Error("db down")) },
      logger: NOOP_LOGGER,
    });

    const outcome = await handler.handle(JOB);
    expect(outcome.outcome).toBe("retry");
  });
});
