import {
  LIVE_PROTOCOL_VERSION,
  serverLiveEventSchema,
  type LiveMode,
} from "@nova/shared";

import type { LiveActionResult, LiveSessionEvent } from "../ipc/contract";
import type { AudioEngineResult } from "./audio-engine";
import type { CreateMeetingResult } from "./meeting";
import { StereoInterleaver } from "./stereo";

/**
 * The live-call orchestrator: pill button in, transcript events out.
 *
 *   start(mode) → create the meeting row → open the authed `/live` socket →
 *   `session.start` (stereo) → on `session.ready`, start the native engine →
 *   me/them batches interleave to stereo frames and go up as binary →
 *   `transcript.*` events come down and are pushed to the renderer.
 *
 * One session at a time, mirroring the server's own one-per-user cap. Every
 * transport/vendor/engine failure lands on the emit channel as a typed event —
 * the pill decides what a person sees; nothing here throws across a seam.
 */

/** One wire batch per channel (960 samples ≈ 60 ms) per stereo frame — inside
 * the server's documented 40–80 ms per-frame envelope even doubled. */
const CHANNEL_FRAME_BYTES = 1920;
/** How long stop() waits for the server's own close before forcing ours. */
const CLOSE_GRACE_MS = 1500;

/** The narrow socket surface the service needs; `ws` satisfies it directly. */
export interface LiveSocket {
  send(data: string | Buffer): void;
  close(): void;
  on(event: "open" | "close", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface LiveSessionDeps {
  apiBaseUrl: string;
  loadEngine: () => AudioEngineResult;
  connect: (url: string, accessToken: string) => LiveSocket;
  getAccessToken: () => Promise<string | null>;
  getUserId: () => string | null;
  createMeeting: (
    accessToken: string,
    userId: string,
  ) => Promise<CreateMeetingResult>;
  emit: (event: LiveSessionEvent) => void;
}

export interface LiveSessionService {
  start(mode: LiveMode): Promise<LiveActionResult>;
  stop(): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

interface ActiveSession {
  socket: LiveSocket | null;
  interleaver: StereoInterleaver;
  engineRunning: boolean;
  ready: boolean;
  paused: boolean;
  /** Set by stop(): the coming socket close is expected, not a failure. */
  stopping: boolean;
  /** Guards teardown against running twice (stop + close event, etc.). */
  finished: boolean;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

export function createLiveSessionService(
  deps: LiveSessionDeps,
): LiveSessionService {
  let active: ActiveSession | null = null;

  function fail(session: ActiveSession, message: string): LiveActionResult {
    // Only the session that still owns the claim may release it: a STALE
    // start unwinding late must not clear a newer session, nor talk over the
    // "ended" status its own teardown already emitted.
    if (active === session) {
      active = null;
      deps.emit({ kind: "status", state: "error", message });
    }
    return { ok: false, message };
  }

  /** Exactly-once teardown; every exit path funnels through here. */
  function finish(session: ActiveSession, event: LiveSessionEvent): void {
    if (session.finished) {
      return;
    }
    session.finished = true;
    if (session.closeTimer !== null) {
      clearTimeout(session.closeTimer);
    }
    if (session.engineRunning) {
      // The engine outlives sockets by design; stop() joins its threads.
      const engine = deps.loadEngine();
      if (engine.ok) {
        engine.engine.stop();
      }
    }
    try {
      session.socket?.close();
    } catch {
      // A socket already closed by the server is fine — this is best-effort.
    }
    active = null;
    deps.emit(event);
  }

  async function start(mode: LiveMode): Promise<LiveActionResult> {
    if (active !== null) {
      return { ok: false, message: "A live session is already running." };
    }
    // Claimed BEFORE the awaits below, so a double-click cannot race two
    // sessions past the guard while the first is still fetching its token.
    const session: ActiveSession = {
      socket: null,
      interleaver: new StereoInterleaver(CHANNEL_FRAME_BYTES),
      engineRunning: false,
      ready: false,
      paused: false,
      stopping: false,
      finished: false,
      closeTimer: null,
    };
    active = session;
    deps.emit({ kind: "status", state: "connecting" });

    // stop()/dispose() can land during any await below; past that point this
    // startup must go inert — no meeting row written, no socket opened, no
    // claim stolen back from a newer session.
    const cancelled = (): boolean => session.finished || active !== session;
    const wasCancelled: LiveActionResult = {
      ok: false,
      message: "The live session was cancelled.",
    };

    const accessToken = await deps.getAccessToken();
    if (cancelled()) {
      return wasCancelled;
    }
    if (accessToken === null) {
      return fail(session, "You are not signed in.");
    }
    const userId = deps.getUserId();
    if (userId === null) {
      return fail(session, "You are not signed in.");
    }

    const meeting = await deps.createMeeting(accessToken, userId);
    if (cancelled()) {
      return wasCancelled;
    }
    if (!meeting.ok) {
      return fail(session, meeting.message);
    }

    const engine = deps.loadEngine();
    if (!engine.ok) {
      return fail(session, engine.message);
    }

    // A socket opened for a torn-down session would leak — `active` is null by
    // then, so nothing could ever close it. (loadEngine is synchronous, so the
    // post-meeting cancellation check still covers this point.)
    let socket: LiveSocket;
    try {
      socket = deps.connect(liveUrl(deps.apiBaseUrl), accessToken);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(session, `Could not open the live connection (${reason}).`);
    }
    session.socket = socket;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          v: LIVE_PROTOCOL_VERSION,
          type: "session.start",
          meeting_id: meeting.meetingId,
          mode,
          channels: 2,
        }),
      );
    });

    socket.on("message", (data) => {
      if (session.finished) {
        return;
      }
      const event = parseServerEvent(data);
      if (event === null) {
        return; // not ours to guess at; the schemas own the wire
      }
      switch (event.type) {
        case "session.ready":
          session.ready = true;
          deps.emit({ kind: "status", state: "live" });
          startEngine(session, engine, socket);
          return;
        case "transcript.partial":
          deps.emit({
            kind: "transcript",
            final: false,
            speaker: event.speaker,
            text: event.text,
            ts_ms: event.ts_ms,
          });
          return;
        case "transcript.final":
          deps.emit({
            kind: "transcript",
            final: true,
            speaker: event.speaker,
            text: event.text,
            ts_ms: event.ts_ms,
          });
          return;
        case "error":
          deps.emit({
            kind: "notice",
            message: `${event.code}: ${event.message}`,
          });
          return;
        case "provider_switched":
          deps.emit({
            kind: "notice",
            message: `transcription switched from ${event.from} to ${event.to}`,
          });
          return;
        default:
          // pong / audio.echo / suggestion.* — suggestions are a later chunk.
          return;
      }
    });

    socket.on("close", () => {
      finish(
        session,
        session.stopping
          ? { kind: "status", state: "ended" }
          : {
              kind: "status",
              state: "error",
              message: session.ready
                ? "The live connection closed unexpectedly."
                : "The live connection was refused. Is the server running (and are you signed in)?",
            },
      );
    });

    socket.on("error", (error) => {
      // `close` follows and runs the real teardown; this only explains why.
      if (!session.finished && !session.stopping) {
        deps.emit({ kind: "notice", message: `connection: ${error.message}` });
      }
    });

    return { ok: true };
  }

  function startEngine(
    session: ActiveSession,
    engine: Extract<AudioEngineResult, { ok: true }>,
    socket: LiveSocket,
  ): void {
    if (session.engineRunning || session.finished) {
      return;
    }
    session.engineRunning = true;
    engine.engine.start(
      (batch) => {
        // Pause gates INTAKE, so both channels stop equally and the pair
        // stays aligned; the session and socket stay warm.
        if (session.finished || session.paused) {
          return;
        }
        session.interleaver.push(batch.stream, batch.pcm);
        for (const frame of session.interleaver.drain()) {
          socket.send(frame);
        }
      },
      (event) => {
        if (!session.finished) {
          deps.emit({
            kind: "notice",
            message: `audio: ${event.type} — ${event.detail}`,
          });
        }
      },
    );
  }

  return {
    start,

    stop() {
      const session = active;
      if (session === null || session.finished) {
        return;
      }
      session.stopping = true;
      try {
        session.socket?.send(
          JSON.stringify({ v: LIVE_PROTOCOL_VERSION, type: "session.end" }),
        );
      } catch {
        // A dead socket still tears down below.
      }
      // The server closes the socket on session.end (its disposer owns that);
      // the timer is the backstop for a server that never answers.
      session.closeTimer = setTimeout(() => {
        finish(session, { kind: "status", state: "ended" });
      }, CLOSE_GRACE_MS);
    },

    setPaused(paused) {
      if (active !== null) {
        active.paused = paused;
      }
    },

    dispose() {
      const session = active;
      if (session !== null) {
        finish(session, { kind: "status", state: "ended" });
      }
    },
  };
}

/** `http(s)://host` → `ws(s)://host/live`. */
function liveUrl(apiBaseUrl: string): string {
  const url = new URL("/live", apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Decode + zod-parse one inbound socket message; null for anything off-wire. */
function parseServerEvent(
  data: unknown,
): ReturnType<typeof serverLiveEventSchema.parse> | null {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (Buffer.isBuffer(data)) {
    text = data.toString("utf8");
  } else {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = serverLiveEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
