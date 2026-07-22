import { describe, expect, it, vi } from "vitest";
import { buildFallbackNotes, type MeetingNotes } from "@nova/shared";

import type { ClaimedJob, JobUsage } from "../../db/jobs.js";

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
 * [notes-quota] Claim-time llm-token quota check (adr-0007 §4): an over-quota job
 * is REFUSED — `failed` with error 'quota_exceeded' (the worker dead-letters it,
 * mirroring notes_status='failed') — NEVER silently completed with fallback
 * notes, because that would hide the paywall. The check runs BEFORE any load or
 * paid work. Optional (keyless posture) and fail-open on an internal failure.
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

function harness(isOverLlmQuota?: (userId: string) => Promise<boolean>) {
  const loadMeeting = vi.fn(() => Promise.resolve(MEETING));
  const source: NotesSource = {
    loadMeeting,
    loadTranscript: () => Promise.resolve(TURNS),
  };
  const generate = vi.fn(() => Promise.resolve({ notes: NOTES, usage: USAGE }));
  const pipeline: NotesPipeline = { generate };
  const writeNotes = vi.fn(() => Promise.resolve());
  const writer: NotesWriter = { writeNotes };
  const handler = createNotesJobHandler({
    pipeline,
    source,
    writer,
    logger: NOOP_LOGGER,
    ...(isOverLlmQuota ? { isOverLlmQuota } : {}),
  });
  return { handler, loadMeeting, generate, writeNotes };
}

describe("createNotesJobHandler [notes-quota]", () => {
  it("over quota → failed('quota_exceeded') with NO load, NO generation, NO write", async () => {
    const isOver = vi.fn(() => Promise.resolve(true));
    const { handler, loadMeeting, generate, writeNotes } = harness(isOver);

    const outcome = await handler.handle(JOB);

    expect(outcome).toEqual({ outcome: "failed", error: "quota_exceeded" });
    expect(isOver).toHaveBeenCalledWith("user-1");
    expect(loadMeeting).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(writeNotes).not.toHaveBeenCalled();
  });

  it("under quota → the normal completed path", async () => {
    const { handler, generate } = harness(() => Promise.resolve(false));
    const outcome = await handler.handle(JOB);
    expect(outcome).toEqual({ outcome: "completed", usage: USAGE });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("a failing quota check FAILS OPEN (job proceeds)", async () => {
    const { handler, generate } = harness(() =>
      Promise.reject(new Error("quota backend down")),
    );
    const outcome = await handler.handle(JOB);
    expect(outcome).toEqual({ outcome: "completed", usage: USAGE });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("no checker wired → unchanged behavior (keyless posture)", async () => {
    const { handler } = harness();
    const outcome = await handler.handle(JOB);
    expect(outcome).toEqual({ outcome: "completed", usage: USAGE });
  });
});
