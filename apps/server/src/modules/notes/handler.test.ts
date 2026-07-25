import { describe, expect, it, vi } from "vitest";
import { buildFallbackNotes, type MeetingNotes } from "@nova/shared";

import type { ClaimedJob, JobUsage } from "../../db/jobs.js";
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
    const generate = vi.fn(() => Promise.resolve({ notes: NOTES, usage: USAGE }));
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
