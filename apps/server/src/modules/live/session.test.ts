import type { ServerLiveEvent } from "@nova/shared";
import { describe, expect, it, vi } from "vitest";

import type { SttEmit, SttEngine } from "../stt/ports.js";

import type {
  LiveLogger,
  TranscriptFinalRow,
  TranscriptPersister,
} from "./ports.js";
import { LiveSession, type LiveSessionDeps } from "./session.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const FIXED_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

/** Build a session whose emitted events are captured for assertions. */
function makeSession(overrides: Partial<LiveSessionDeps> = {}): {
  session: LiveSession;
  sent: ServerLiveEvent[];
} {
  const sent: ServerLiveEvent[] = [];
  const session = new LiveSession({
    send: (event) => sent.push(event),
    generateSessionId: () => FIXED_SESSION_ID,
    ...overrides,
  });
  return { session, sent };
}

const startFrame = (echo = false): string =>
  JSON.stringify({ v: 1, type: "session.start", meeting_id: MEETING_ID, echo });

describe("LiveSession control events", () => {
  it("replies session.ready with a session id on session.start", () => {
    const { session, sent } = makeSession();

    session.handleTextMessage(startFrame());

    expect(sent).toEqual([
      { v: 1, type: "session.ready", session_id: FIXED_SESSION_ID },
    ]);
    expect(session.id).toBe(FIXED_SESSION_ID);
  });

  it("replies pong to ping", () => {
    const { session, sent } = makeSession();
    session.handleTextMessage(JSON.stringify({ v: 1, type: "ping" }));
    expect(sent).toEqual([{ v: 1, type: "pong" }]);
  });

  it("rejects a second session.start as already_started (does not restart)", () => {
    const { session, sent } = makeSession();
    session.handleTextMessage(startFrame());
    session.handleTextMessage(startFrame());

    expect(sent[1]).toEqual({
      v: 1,
      type: "error",
      code: "already_started",
      message: "session already started",
    });
  });

  it("emits an error (not a throw) for malformed JSON", () => {
    const { session, sent } = makeSession();
    session.handleTextMessage("{not json");
    expect(sent[0]).toMatchObject({ type: "error", code: "invalid_json" });
  });

  it("emits an error for a well-formed but unrecognized event", () => {
    const { session, sent } = makeSession();
    session.handleTextMessage(JSON.stringify({ v: 1, type: "bogus" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "invalid_event" });
  });

  it("rejects a JSON audio.frame marker (audio must be binary)", () => {
    const { session, sent } = makeSession();
    session.handleTextMessage(startFrame());
    session.handleTextMessage(JSON.stringify({ v: 1, type: "audio.frame" }));
    expect(sent[1]).toMatchObject({ type: "error", code: "invalid_event" });
  });
});

describe("LiveSession binary audio path", () => {
  it("errors on a binary frame received before session.start", () => {
    const { session, sent } = makeSession();
    session.handleBinaryMessage(Buffer.from([1, 2, 3]));
    expect(sent[0]).toMatchObject({
      type: "error",
      code: "audio_before_start",
    });
  });

  it("hands post-start frames to the audio seam", () => {
    const onAudioFrame = vi.fn();
    const { session } = makeSession({ onAudioFrame });
    session.handleTextMessage(startFrame());

    const frame = Buffer.from([9, 8, 7, 6]);
    session.handleBinaryMessage(frame);

    expect(onAudioFrame).toHaveBeenCalledTimes(1);
    expect(onAudioFrame).toHaveBeenCalledWith(session, frame);
  });

  it("echoes frame byte-length only when echo is allowed AND requested", () => {
    const { session, sent } = makeSession({ allowEcho: true });
    session.handleTextMessage(startFrame(true));
    session.handleBinaryMessage(Buffer.from([1, 2, 3, 4, 5]));

    expect(sent.at(-1)).toEqual({ v: 1, type: "audio.echo", bytes: 5 });
  });

  it("never echoes when echo is not allowed, even if requested", () => {
    const { session, sent } = makeSession({ allowEcho: false });
    session.handleTextMessage(startFrame(true));
    session.handleBinaryMessage(Buffer.from([1, 2, 3, 4, 5]));

    expect(sent.some((e) => e.type === "audio.echo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transcript-persistence harness: a fake STT engine whose emit sink the test can
// drive directly, plus a controllable persister + logger.
// ---------------------------------------------------------------------------

interface FakeEngine {
  engine: SttEngine;
  /** Push an event as if the vendor emitted it (into the session's real sink). */
  emit: (event: ServerLiveEvent) => void;
  /** How many times the per-session handle's stop() was called. */
  stops: () => number;
  /** How many times a per-call engine session was started. */
  starts: () => number;
}

function makeFakeEngine(): FakeEngine {
  let captured: SttEmit | null = null;
  let stops = 0;
  let starts = 0;
  const engine: SttEngine = {
    startSession(_info, emit) {
      starts += 1;
      captured = emit;
      return {
        onAudioFrame() {
          /* not exercised here */
        },
        stop() {
          stops += 1;
        },
      };
    },
  };
  return {
    engine,
    emit: (event) => {
      if (captured) captured(event);
    },
    stops: () => stops,
    starts: () => starts,
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function defer(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class FakePersister implements TranscriptPersister {
  readonly saveCalls: TranscriptFinalRow[] = [];
  readonly markEndedCalls: { meetingId: string; userId: string }[] = [];
  readonly ownershipCalls: { meetingId: string; userId: string }[] = [];
  /** When set, `saveFinal` returns this pending promise instead of resolving. */
  saveGate: Deferred | null = null;
  /** When set, `saveFinal` rejects with it. */
  saveError: Error | null = null;
  /** What `verifyMeetingOwnership` resolves to (default: the caller owns it). */
  ownsResult = true;
  /** When set, `verifyMeetingOwnership` REJECTS (a DB-down → fail-closed start). */
  ownershipError: Error | null = null;

  saveFinal(row: TranscriptFinalRow): Promise<void> {
    this.saveCalls.push(row);
    if (this.saveError) return Promise.reject(this.saveError);
    return this.saveGate ? this.saveGate.promise : Promise.resolve();
  }

  markEnded(meetingId: string, userId: string): Promise<void> {
    this.markEndedCalls.push({ meetingId, userId });
    return Promise.resolve();
  }

  verifyMeetingOwnership(meetingId: string, userId: string): Promise<boolean> {
    this.ownershipCalls.push({ meetingId, userId });
    if (this.ownershipError) return Promise.reject(this.ownershipError);
    return Promise.resolve(this.ownsResult);
  }
}

const finalEvent = (
  text: string,
  speaker: string | null = "spk_0",
  ts_ms = 100,
): ServerLiveEvent => ({
  v: 1,
  type: "transcript.final",
  text,
  speaker,
  ts_ms,
  is_final: true,
});

const partialEvent = (text: string): ServerLiveEvent => ({
  v: 1,
  type: "transcript.partial",
  text,
  speaker: "spk_0",
  ts_ms: 100,
});

/** Let queued microtasks + one macrotask settle (fire-and-forget writes resolve). */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("LiveSession transcript persistence", () => {
  it("persists FINAL transcripts and never partials", async () => {
    const fake = makeFakeEngine();
    const persister = new FakePersister();
    const { session } = makeSession({
      sttEngine: fake.engine,
      persister,
      userId: USER_ID,
    });
    session.handleTextMessage(startFrame());
    await flush(); // let the async ownership guard resolve so the STT engine starts

    fake.emit(partialEvent("interim"));
    fake.emit(finalEvent("committed one"));
    fake.emit(partialEvent("more interim"));
    fake.emit(finalEvent("committed two", null, 250));
    await flush();

    expect(persister.saveCalls.map((c) => c.content)).toEqual([
      "committed one",
      "committed two",
    ]);
    expect(persister.saveCalls[0]).toEqual({
      meetingId: MEETING_ID,
      userId: USER_ID,
      content: "committed one",
      speaker: "spk_0",
      tsMs: 100,
    });
    // Nullable diarization/timing flow through unchanged.
    expect(persister.saveCalls[1]).toMatchObject({ speaker: null, tsMs: 250 });
  });

  it("flushes pending final writes BEFORE marking the call ended", async () => {
    const fake = makeFakeEngine();
    const persister = new FakePersister();
    const gate = defer();
    persister.saveGate = gate;
    const { session } = makeSession({
      sttEngine: fake.engine,
      persister,
      userId: USER_ID,
    });
    session.handleTextMessage(startFrame());
    await flush(); // let the async ownership guard resolve so the STT engine starts
    fake.emit(finalEvent("still writing"));

    session.close(); // disposal kicks off finalize (await writes → markEnded)
    await flush();
    // The write is still gated, so markEnded must not have fired yet.
    expect(persister.markEndedCalls).toHaveLength(0);

    gate.resolve();
    await flush();
    expect(persister.markEndedCalls).toEqual([
      { meetingId: MEETING_ID, userId: USER_ID },
    ]);
  });

  it("logs a persist failure and leaves the socket relay unaffected", async () => {
    const fake = makeFakeEngine();
    const persister = new FakePersister();
    persister.saveError = new Error("db down");
    const errors: { fields: Record<string, unknown>; msg: string }[] = [];
    const logger: LiveLogger = {
      error: (fields, msg) => errors.push({ fields, msg }),
    };
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      persister,
      userId: USER_ID,
      logger,
    });
    session.handleTextMessage(startFrame());
    await flush(); // let the async ownership guard resolve so the STT engine starts
    fake.emit(finalEvent("still delivered"));
    await flush();

    // Relay unaffected: the final still reached the socket.
    expect(
      sent.some(
        (e) => e.type === "transcript.final" && e.text === "still delivered",
      ),
    ).toBe(true);
    // Failure logged with ids only — never transcript content (RULES §6).
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe("live.transcript_persist_failed");
    expect(errors[0]?.fields).toMatchObject({
      user_id: USER_ID,
      meeting_id: MEETING_ID,
    });
    expect(JSON.stringify(errors[0]?.fields)).not.toContain("still delivered");
  });

  it("marks ended once across every disposal call after start", async () => {
    const persister = new FakePersister();
    const { session } = makeSession({ persister, userId: USER_ID });
    session.handleTextMessage(startFrame());
    await flush(); // guard resolves + persistence teardown registers before disposal

    session.handleTextMessage(JSON.stringify({ v: 1, type: "session.end" }));
    session.close(); // belt-and-suspenders transport close
    await flush();

    expect(persister.markEndedCalls).toEqual([
      { meetingId: MEETING_ID, userId: USER_ID },
    ]);
  });

  it("does not mark ended when the session never started", async () => {
    const persister = new FakePersister();
    const { session } = makeSession({ persister, userId: USER_ID });
    session.close();
    await flush();
    expect(persister.markEndedCalls).toHaveLength(0);
  });
});

describe("LiveSession meeting-ownership guard (C1)", () => {
  it("proceeds (ready + engine start) when the caller owns the meeting", async () => {
    const fake = makeFakeEngine();
    const persister = new FakePersister();
    persister.ownsResult = true;
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      persister,
      userId: USER_ID,
    });

    session.handleTextMessage(startFrame());
    // Nothing happens until the async guard resolves: no ready, no engine start yet.
    expect(sent).toHaveLength(0);
    expect(fake.starts()).toBe(0);

    await flush();

    expect(persister.ownershipCalls).toEqual([
      { meetingId: MEETING_ID, userId: USER_ID },
    ]);
    expect(sent).toEqual([
      { v: 1, type: "session.ready", session_id: FIXED_SESSION_ID },
    ]);
    expect(fake.starts()).toBe(1);
    expect(session.disposer.disposed).toBe(false);
  });

  it("rejects a NON-owned meeting BEFORE the engine starts (meeting_forbidden + close)", async () => {
    const fake = makeFakeEngine();
    const persister = new FakePersister();
    persister.ownsResult = false; // wrong owner / missing / soft-deleted
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      persister,
      userId: USER_ID,
    });

    session.handleTextMessage(startFrame());
    await flush();

    // Typed error + policy close, and the engine NEVER started (no vendor cost, no
    // transcript write path opened) — the socket is torn down.
    expect(sent).toEqual([
      {
        v: 1,
        type: "error",
        code: "meeting_forbidden",
        message: "meeting not found or not owned by caller",
      },
    ]);
    expect(fake.starts()).toBe(0);
    expect(session.disposer.disposed).toBe(true);
    expect(session.id).toBeNull();
    // No transcript work and no ended-stamp for a meeting we refused.
    expect(persister.saveCalls).toHaveLength(0);
    expect(persister.markEndedCalls).toHaveLength(0);
  });

  it("fails CLOSED on a DB error (internal error + close, engine never starts)", async () => {
    const fake = makeFakeEngine();
    const persister = new FakePersister();
    persister.ownershipError = new Error("db unreachable");
    const errors: { fields: Record<string, unknown>; msg: string }[] = [];
    const logger: LiveLogger = {
      error: (fields, msg) => errors.push({ fields, msg }),
    };
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      persister,
      userId: USER_ID,
      logger,
    });

    session.handleTextMessage(startFrame());
    await flush();

    // A DB-unavailable start is REFUSED (not silently accepted): typed error + close.
    expect(sent).toEqual([
      {
        v: 1,
        type: "error",
        code: "internal",
        message: "could not verify meeting ownership",
      },
    ]);
    expect(fake.starts()).toBe(0);
    expect(session.disposer.disposed).toBe(true);
    // Logged with ids only — never meeting content leaks into the log fields.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe("live.meeting_ownership_check_failed");
    expect(errors[0]?.fields).toMatchObject({
      user_id: USER_ID,
      meeting_id: MEETING_ID,
    });
  });

  it("does not verify ownership at all when no persister is wired (dev-mode)", async () => {
    // DB-less dev session: streams without persistence, so there is nothing to
    // guard and no DB to ask — session.ready is emitted with no ownership call.
    const fake = makeFakeEngine();
    const { session, sent } = makeSession({ sttEngine: fake.engine });

    session.handleTextMessage(startFrame());
    await flush();

    expect(sent).toEqual([
      { v: 1, type: "session.ready", session_id: FIXED_SESSION_ID },
    ]);
    expect(fake.starts()).toBe(1);
  });
});

describe("LiveSession teardown (exactly-once)", () => {
  it("runs registered cleanup exactly once across end + close + close", () => {
    const { session } = makeSession();
    const cleanup = vi.fn();
    session.disposer.add(cleanup);

    // session.end drives teardown, then belt-and-suspenders transport closes.
    session.handleTextMessage(JSON.stringify({ v: 1, type: "session.end" }));
    session.close();
    session.close();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(session.disposer.disposed).toBe(true);
  });
});
