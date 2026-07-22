import { describe, expect, it, vi } from "vitest";

import type { ClaimedJob, NotesJobStore } from "../../db/jobs.js";

import type { NotesJobHandler, NotesLogger } from "./ports.js";
import { createNotesWorker } from "./worker.js";

/**
 * [worker-cap] The kill-switch gates the CLAIM itself (adr-0007 §5): a tripped
 * daily cap makes `tickOnce` return WITHOUT claiming — no attempts burned, jobs
 * stay queued untouched and simply wait out the day (nothing is lost, nothing
 * dead-letters); work claimed BEFORE the trip finishes because the gate is
 * per-tick, never mid-job. Optional (keyless posture) and fail-open.
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

function fakeStore(): {
  store: NotesJobStore;
  claim: ReturnType<typeof vi.fn>;
} {
  const claim = vi.fn(() => Promise.resolve(JOB));
  const store: NotesJobStore = {
    enqueue: () => Promise.resolve("enqueued"),
    claim,
    complete: () => Promise.resolve(),
    retry: () => Promise.resolve(),
    fail: () => Promise.resolve(),
    reapExpired: () => Promise.resolve(0),
    sweepEnqueue: () => Promise.resolve(0),
    hasActive: () => Promise.resolve(false),
  };
  return { store, claim };
}

const completingHandler: NotesJobHandler = {
  handle: () => Promise.resolve({ outcome: "completed", usage: [] }),
};

describe("notes worker [worker-cap] — claim gate", () => {
  it("[worker-cap] a tripped cap skips the claim entirely (0 processed, no store call)", async () => {
    const { store, claim } = fakeStore();
    const worker = createNotesWorker({
      store,
      handler: completingHandler,
      logger: NOOP_LOGGER,
      isDailyCapReached: () => Promise.resolve(true),
    });

    expect(await worker.tickOnce()).toBe(0);
    expect(claim).not.toHaveBeenCalled();
  });

  it("[worker-cap] under the cap the tick claims and processes normally", async () => {
    const { store, claim } = fakeStore();
    const worker = createNotesWorker({
      store,
      handler: completingHandler,
      logger: NOOP_LOGGER,
      isDailyCapReached: () => Promise.resolve(false),
    });

    expect(await worker.tickOnce()).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("[worker-cap] a failing cap check FAILS OPEN (the tick claims)", async () => {
    const { store, claim } = fakeStore();
    const worker = createNotesWorker({
      store,
      handler: completingHandler,
      logger: NOOP_LOGGER,
      isDailyCapReached: () => Promise.reject(new Error("sum backend down")),
    });

    expect(await worker.tickOnce()).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("[worker-cap] no gate wired → unchanged behavior (keyless posture)", async () => {
    const { store } = fakeStore();
    const worker = createNotesWorker({
      store,
      handler: completingHandler,
      logger: NOOP_LOGGER,
    });
    expect(await worker.tickOnce()).toBe(1);
  });
});
