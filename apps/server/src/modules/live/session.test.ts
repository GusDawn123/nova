import type { ServerLiveEvent } from "@nova/shared";
import { describe, expect, it, vi } from "vitest";

import { LiveSession, type LiveSessionDeps } from "./session.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const FIXED_SESSION_ID = "22222222-2222-4222-8222-222222222222";

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
    expect(sent[0]).toMatchObject({ type: "error", code: "audio_before_start" });
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
