import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveSessionEvent } from "../ipc/contract";
import type {
  AudioBatch,
  AudioEngineEvent,
  AudioEngineResult,
} from "./audio-engine";
import type { CreateMeetingResult } from "./meeting";
import { createLiveSessionService, type LiveSocket } from "./session";

/**
 * The orchestration seams, faked at their narrow interfaces: a scripted
 * socket, a hand-cranked engine, an instant meeting. What's asserted is the
 * only thing that matters — what goes UP the socket and what comes OUT the
 * emit channel.
 */

class FakeSocket implements LiveSocket {
  readonly sent: (string | Buffer)[] = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    ((...args: never[]) => void)[]
  >();

  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
  jsonSent(): unknown[] {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d): unknown => JSON.parse(d));
  }
  binarySent(): Buffer[] {
    return this.sent.filter((d): d is Buffer => Buffer.isBuffer(d));
  }
}

class FakeEngine {
  onBatch: ((batch: AudioBatch) => void) | null = null;
  onEvent: ((event: AudioEngineEvent) => void) | null = null;
  stopped = 0;

  start(
    onBatch: (batch: AudioBatch) => void,
    onEvent: (event: AudioEngineEvent) => void,
  ): void {
    this.onBatch = onBatch;
    this.onEvent = onEvent;
  }
  stop(): { droppedBatches: number } {
    this.stopped += 1;
    return { droppedBatches: 0 };
  }
}

function harness(overrides?: {
  accessToken?: string | null | Promise<string | null>;
  userId?: string | null;
  engineResult?: AudioEngineResult;
  meeting?:
    | CreateMeetingResult
    | Promise<CreateMeetingResult>
    | (() => CreateMeetingResult | Promise<CreateMeetingResult>);
  connect?: (url: string, accessToken: string) => LiveSocket;
}) {
  const socket = new FakeSocket();
  const engine = new FakeEngine();
  const events: LiveSessionEvent[] = [];
  let connectCalls = 0;
  let meetingCalls = 0;
  const service = createLiveSessionService({
    apiBaseUrl: "http://127.0.0.1:3000",
    loadEngine: () => overrides?.engineResult ?? { ok: true, engine },
    connect: (url, token) => {
      connectCalls += 1;
      return overrides?.connect === undefined
        ? socket
        : overrides.connect(url, token);
    },
    getAccessToken: () =>
      Promise.resolve(
        overrides?.accessToken === undefined
          ? "token-1"
          : overrides.accessToken,
      ),
    getUserId: () =>
      overrides?.userId === undefined ? "user-1" : overrides.userId,
    createMeeting: () => {
      meetingCalls += 1;
      const meeting = overrides?.meeting;
      if (meeting === undefined) {
        return Promise.resolve<CreateMeetingResult>({
          ok: true,
          meetingId: "11111111-2222-4333-8444-555555555555",
        });
      }
      return Promise.resolve(
        typeof meeting === "function" ? meeting() : meeting,
      );
    },
    emit: (event) => {
      events.push(event);
    },
  });
  return {
    socket,
    engine,
    events,
    service,
    connectCalls: () => connectCalls,
    meetingCalls: () => meetingCalls,
  };
}

/** A wire batch (960 samples ≈ 60 ms) of a constant PCM16 value. */
function batch(stream: "me" | "them", value: number): AudioBatch {
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(value, i * 2);
  return { stream, pcm };
}

const ready = JSON.stringify({
  v: 1,
  type: "session.ready",
  session_id: "99999999-8888-4777-8666-555555555555",
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("live session service", () => {
  it("opens the socket and starts a stereo session in the picked mode", async () => {
    const { socket, events, service } = harness();
    const result = await service.start("technical");
    expect(result.ok).toBe(true);
    expect(events[0]).toEqual({ kind: "status", state: "connecting" });

    socket.fire("open");
    expect(socket.jsonSent()).toEqual([
      {
        v: 1,
        type: "session.start",
        meeting_id: "11111111-2222-4333-8444-555555555555",
        mode: "technical",
        channels: 2,
      },
    ]);
  });

  it("starts the engine only on session.ready and ships interleaved stereo", async () => {
    const { socket, engine, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    expect(engine.onBatch).toBeNull(); // audio before ready would be refused

    socket.fire("message", ready);
    expect(events).toContainEqual({ kind: "status", state: "live" });
    expect(engine.onBatch).not.toBeNull();

    engine.onBatch?.(batch("me", 100));
    expect(socket.binarySent()).toHaveLength(0); // needs BOTH channels
    engine.onBatch?.(batch("them", -200));
    const frames = socket.binarySent();
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error("expected a frame");
    expect(frame.length).toBe(3840); // 960 stereo samples
    expect([frame.readInt16LE(0), frame.readInt16LE(2)]).toEqual([100, -200]);
  });

  it("forwards transcript partials and finals to the emit channel", async () => {
    const { socket, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    socket.fire(
      "message",
      JSON.stringify({
        v: 1,
        type: "transcript.partial",
        text: "hel",
        speaker: "me",
        ts_ms: 120,
      }),
    );
    socket.fire(
      "message",
      JSON.stringify({
        v: 1,
        type: "transcript.final",
        text: "hello there",
        speaker: "them",
        ts_ms: 900,
        is_final: true,
      }),
    );
    expect(events).toContainEqual({
      kind: "transcript",
      final: false,
      speaker: "me",
      text: "hel",
      ts_ms: 120,
    });
    expect(events).toContainEqual({
      kind: "transcript",
      final: true,
      speaker: "them",
      text: "hello there",
      ts_ms: 900,
    });
  });

  it("forwards the suggestion lifecycle to the emit channel", async () => {
    const { socket, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    socket.fire(
      "message",
      JSON.stringify({
        v: 1,
        type: "suggestion.start",
        suggestion_id: sid,
        kind: "answer",
      }),
    );
    socket.fire(
      "message",
      JSON.stringify({
        v: 1,
        type: "suggestion.delta",
        suggestion_id: sid,
        text: "Short answer",
      }),
    );
    socket.fire(
      "message",
      JSON.stringify({
        v: 1,
        type: "suggestion.done",
        suggestion_id: sid,
        text: "Short answer, upgraded.",
      }),
    );
    expect(events).toContainEqual({
      kind: "suggestion",
      phase: "start",
      id: sid,
      text: "",
    });
    expect(events).toContainEqual({
      kind: "suggestion",
      phase: "delta",
      id: sid,
      text: "Short answer",
    });
    expect(events).toContainEqual({
      kind: "suggestion",
      phase: "done",
      id: sid,
      text: "Short answer, upgraded.",
    });
  });

  it("ask(text) sends a typed copilot question up the socket", async () => {
    const { socket, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    const result = service.ask("how do I answer the budget pushback?");
    expect(result).toEqual({ ok: true });
    expect(socket.jsonSent().at(-1)).toEqual({
      v: 1,
      type: "transcript.input",
      text: "how do I answer the budget pushback?",
      origin: "copilot_question",
    });
  });

  it("ask(null) sends the empty-handed Answer press as suggest.now", async () => {
    const { socket, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    const result = service.ask(null);
    expect(result).toEqual({ ok: true });
    expect(socket.jsonSent().at(-1)).toEqual({ v: 1, type: "suggest.now" });
  });

  it("ask refuses typed when no session is running", () => {
    const { service } = harness();
    expect(service.ask("anyone there?")).toEqual({
      ok: false,
      message: "No live session is running.",
    });
  });

  it("ask refuses before session.ready — the server would too", async () => {
    const { socket, service } = harness();
    await service.start("general");
    socket.fire("open"); // connected, but session.ready never arrived
    const result = service.ask(null);
    expect(result.ok).toBe(false);
    // Nothing but the session.start went up.
    expect(socket.jsonSent()).toHaveLength(1);
  });

  it("ask refuses once stop() queued session.end — no ok for a dead answer", async () => {
    const { socket, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    service.stop();
    const result = service.ask(null);
    expect(result).toEqual({
      ok: false,
      message: "No live session is running.",
    });
    // session.start + session.end and nothing behind them.
    expect(socket.jsonSent().at(-1)).toMatchObject({ type: "session.end" });
  });

  it("ask fails typed when the socket throws mid-send", async () => {
    const { socket, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    socket.send = () => {
      throw new Error("socket buried");
    };
    const result = service.ask("still there?");
    expect(result).toEqual({
      ok: false,
      message: "The ask could not be sent (socket buried).",
    });
  });

  it("forwards a discard so the pill can clear the pane", async () => {
    const { socket, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    socket.fire(
      "message",
      JSON.stringify({
        v: 1,
        type: "suggestion.discard",
        suggestion_id: sid,
        reason: "superseded",
      }),
    );
    expect(events).toContainEqual({
      kind: "suggestion",
      phase: "discard",
      id: sid,
      text: "",
    });
  });

  it("pauses by gating intake so both channels stay aligned", async () => {
    const { socket, engine, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);

    service.setPaused(true);
    engine.onBatch?.(batch("me", 1));
    engine.onBatch?.(batch("them", 1));
    expect(socket.binarySent()).toHaveLength(0);

    service.setPaused(false);
    engine.onBatch?.(batch("me", 2));
    engine.onBatch?.(batch("them", 2));
    const frames = socket.binarySent();
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error("expected a frame");
    // The pre-pause value 1 must appear nowhere: pause gates INTAKE, so no
    // half-pair survives it to be mispaired with post-resume audio.
    expect([frame.readInt16LE(0), frame.readInt16LE(2)]).toEqual([2, 2]);
  });

  it("stop() sends session.end, and the server's close ends the session cleanly", async () => {
    const { socket, engine, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);

    service.stop();
    expect(socket.jsonSent().at(-1)).toMatchObject({ type: "session.end" });

    socket.fire("close");
    expect(engine.stopped).toBe(1);
    expect(events.at(-1)).toEqual({ kind: "status", state: "ended" });

    // A second session may start after the first ended.
    const again = await service.start("general");
    expect(again.ok).toBe(true);
  });

  it("stop() force-closes when the server never answers", async () => {
    const { socket, engine, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);

    service.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(engine.stopped).toBe(1);
    expect(socket.closed).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "status", state: "ended" });
  });

  it("an unexpected close mid-call surfaces as an error status", async () => {
    const { socket, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);

    socket.fire("close");
    expect(events.at(-1)).toEqual({
      kind: "status",
      state: "error",
      message: "The live connection closed unexpectedly.",
    });
  });

  it("refuses a second concurrent start", async () => {
    const { socket, service } = harness();
    await service.start("general");
    socket.fire("open");
    const second = await service.start("general");
    expect(second).toEqual({
      ok: false,
      message: "A live session is already running.",
    });
  });

  it("fails typed (and emits an error status) when signed out", async () => {
    const { events, service } = harness({ accessToken: null });
    const result = await service.start("general");
    expect(result).toEqual({ ok: false, message: "You are not signed in." });
    expect(events.at(-1)).toEqual({
      kind: "status",
      state: "error",
      message: "You are not signed in.",
    });
    // And the failed attempt must not latch the running-guard.
    const retry = await service.start("general");
    expect(retry.ok).toBe(false); // still signed out…
    expect(retry.message).toBe("You are not signed in."); // …but not "already running"
  });

  it("fails typed when the user id is missing despite a valid token", async () => {
    const { events, service } = harness({ userId: null });
    const result = await service.start("general");
    expect(result).toEqual({ ok: false, message: "You are not signed in." });
    expect(events.at(-1)).toMatchObject({ kind: "status", state: "error" });
  });

  it("fails typed when the meeting row cannot be created", async () => {
    const { events, service } = harness({
      meeting: { ok: false, message: "Could not create the meeting (500)." },
    });
    const result = await service.start("general");
    expect(result).toEqual({
      ok: false,
      message: "Could not create the meeting (500).",
    });
    expect(events.at(-1)).toMatchObject({ kind: "status", state: "error" });
    // The guard released: the retry hits the same meeting error, not
    // "A live session is already running."
    const retry = await service.start("general");
    expect(retry).toEqual({
      ok: false,
      message: "Could not create the meeting (500).",
    });
  });

  it("fails typed when the native engine cannot load, and opens no socket", async () => {
    const { events, service, connectCalls } = harness({
      engineResult: { ok: false, message: "The audio engine could not load." },
    });
    const result = await service.start("general");
    expect(result).toEqual({
      ok: false,
      message: "The audio engine could not load.",
    });
    expect(connectCalls()).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: "status", state: "error" });
  });

  it("a close before session.ready reads as a refused connection", async () => {
    const { socket, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("close");
    expect(events.at(-1)).toEqual({
      kind: "status",
      state: "error",
      message:
        "The live connection was refused. Is the server running (and are you signed in)?",
    });
    // The guard released: a second start is accepted.
    const again = await service.start("general");
    expect(again.ok).toBe(true);
  });

  it("dispose() during the meeting insert never opens a socket", async () => {
    let resolveMeeting!: (result: CreateMeetingResult) => void;
    const meeting = new Promise<CreateMeetingResult>((resolve) => {
      resolveMeeting = resolve;
    });
    const { events, service, connectCalls } = harness({ meeting });
    const pending = service.start("general");
    // App quit while the insert is in flight: the socket a late-resolving
    // start would open could never be closed (`active` is already null).
    service.dispose();
    resolveMeeting({
      ok: true,
      meetingId: "11111111-2222-4333-8444-555555555555",
    });
    const result = await pending;
    expect(result).toEqual({
      ok: false,
      message: "The live session was cancelled.",
    });
    expect(connectCalls()).toBe(0);
    expect(events.at(-1)).toEqual({ kind: "status", state: "ended" });
  });

  it("dispose() before the token resolves never creates a meeting row", async () => {
    let resolveToken!: (token: string | null) => void;
    const accessToken = new Promise<string | null>((resolve) => {
      resolveToken = resolve;
    });
    const { events, service, meetingCalls, connectCalls } = harness({
      accessToken,
    });
    const pending = service.start("general");
    // App quit while sign-in is still resolving: the stale startup must not
    // write a meeting row for a call that can never happen.
    service.dispose();
    resolveToken("token-1");
    const result = await pending;
    expect(result).toEqual({
      ok: false,
      message: "The live session was cancelled.",
    });
    expect(meetingCalls()).toBe(0);
    expect(connectCalls()).toBe(0);
    expect(events.at(-1)).toEqual({ kind: "status", state: "ended" });
  });

  // What this proves observably: the stale start goes inert via the
  // cancellation check, emitting nothing and leaving the newer session's
  // claim untouched. fail()'s own `active === session` guard is a backstop
  // for future code where a fail site follows an await without a preceding
  // cancellation check; no such path exists today, so no test can reach it.
  it("a stale startup resolving late goes inert without touching the newer session", async () => {
    let firstCall = true;
    let resolveFirstInsert!: (result: CreateMeetingResult) => void;
    const firstInsert = new Promise<CreateMeetingResult>((resolve) => {
      resolveFirstInsert = resolve;
    });
    const { events, service, meetingCalls } = harness({
      meeting: () => {
        if (firstCall) {
          firstCall = false;
          return firstInsert;
        }
        return {
          ok: true,
          meetingId: "11111111-2222-4333-8444-555555555555",
        };
      },
    });

    const stale = service.start("general");
    // Let startup #1 get INTO the hanging insert before the user cancels —
    // cancelling any earlier would (correctly) skip the insert entirely.
    await Promise.resolve();
    await Promise.resolve();
    expect(meetingCalls()).toBe(1);

    service.dispose(); // the user cancels while insert #1 hangs…
    const second = await service.start("general"); // …and starts fresh
    expect(second.ok).toBe(true);

    resolveFirstInsert({ ok: false, message: "boom" }); // insert #1 fails LATE
    await expect(stale).resolves.toEqual({
      ok: false,
      message: "The live session was cancelled.",
    });
    // The newer session is untouched: no error status followed its
    // "connecting", and it still owns the running-guard.
    expect(events.at(-1)).toEqual({ kind: "status", state: "connecting" });
    const third = await service.start("general");
    expect(third).toEqual({
      ok: false,
      message: "A live session is already running.",
    });
  });

  it("a throwing connect fails typed and releases the running-guard", async () => {
    const { events, service } = harness({
      connect: () => {
        throw new Error("bad url");
      },
    });
    const result = await service.start("general");
    expect(result).toEqual({
      ok: false,
      message: "Could not open the live connection (bad url).",
    });
    expect(events.at(-1)).toMatchObject({ kind: "status", state: "error" });
    // Released: the retry hits the same connect error, not "already running."
    const again = await service.start("general");
    expect(again).toEqual({
      ok: false,
      message: "Could not open the live connection (bad url).",
    });
  });

  it("dispose() tears down a live session (the will-quit path)", async () => {
    const { socket, engine, events, service } = harness();
    await service.start("general");
    socket.fire("open");
    socket.fire("message", ready);
    service.dispose();
    expect(engine.stopped).toBe(1);
    expect(socket.closed).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "status", state: "ended" });
  });
});
