import { describe, expect, it } from "vitest";
import type { LiveMode, ServerLiveEvent } from "@nova/shared";

import { LiveSession, type LiveSessionDeps } from "./session.js";

/**
 * [live-mode] The picked mode's journey across the transport: parsed off
 * `session.start`, handed to the conductor factory for THIS session, and never
 * shared with another.
 *
 * The last part is why these are session-level tests rather than a conductor
 * unit test. One process serves every call; a mode remembered anywhere but in
 * the per-session factory call would answer one user's finance call with
 * another's technical prompt, and nothing downstream would look wrong.
 */

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MEETING_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "55555555-5555-4555-8555-555555555555";

/** Records the args every conductor build was given (the assertion surface). */
function recordingFactory(): {
  factory: NonNullable<LiveSessionDeps["createConductor"]>;
  builds: { meetingId: string; mode: LiveMode }[];
} {
  const builds: { meetingId: string; mode: LiveMode }[] = [];
  const factory: NonNullable<LiveSessionDeps["createConductor"]> = (args) => {
    builds.push({ meetingId: args.meetingId, mode: args.mode });
    return {
      onPartial: () => undefined,
      onFinal: () => undefined,
      onDirectQuestion: () => undefined,
      answerNow: () => undefined,
      dispose: () => undefined,
    };
  };
  return { factory, builds };
}

function makeSession(overrides: Partial<LiveSessionDeps> = {}): {
  session: LiveSession;
  sent: ServerLiveEvent[];
} {
  const sent: ServerLiveEvent[] = [];
  const session = new LiveSession({
    send: (event) => sent.push(event),
    userId: USER_ID,
    ...overrides,
  });
  return { session, sent };
}

const startFrame = (mode?: string, meetingId: string = MEETING_ID): string =>
  JSON.stringify({
    v: 1,
    type: "session.start",
    meeting_id: meetingId,
    ...(mode !== undefined ? { mode } : {}),
  });

describe("modules/live [live-mode] session.start carries the picked mode", () => {
  it("[live-mode] hands the picked mode to the conductor factory", () => {
    const { factory, builds } = recordingFactory();
    const { session } = makeSession({ createConductor: factory });

    session.handleTextMessage(startFrame("technical"));

    expect(builds).toEqual([{ meetingId: MEETING_ID, mode: "technical" }]);
  });

  it("[live-mode] an OMITTED mode means general (an old client still works)", () => {
    const { factory, builds } = recordingFactory();
    const { session } = makeSession({ createConductor: factory });

    session.handleTextMessage(startFrame());

    expect(builds).toEqual([{ meetingId: MEETING_ID, mode: "general" }]);
  });

  it("[live-mode] an UNKNOWN mode is refused at the boundary, not defaulted", () => {
    const { factory, builds } = recordingFactory();
    const { session, sent } = makeSession({ createConductor: factory });

    session.handleTextMessage(startFrame("sales"));

    // The existing typed-error path, unchanged: the frame fails the zod parse,
    // so no session starts and no conductor is built. Silently serving general
    // would hide the client bug behind answers that look almost right.
    expect(sent.map((e) => e.type)).toEqual(["error"]);
    expect(sent[0]).toMatchObject({ type: "error", code: "invalid_event" });
    expect(builds).toEqual([]);
  });

  it("[live-mode] two concurrent sessions each keep their OWN mode", () => {
    const { factory, builds } = recordingFactory();
    const a = makeSession({ createConductor: factory });
    const b = makeSession({
      createConductor: factory,
      userId: OTHER_USER_ID,
    });

    a.session.handleTextMessage(startFrame("finance"));
    b.session.handleTextMessage(startFrame("behavioral", OTHER_MEETING_ID));

    expect(builds).toEqual([
      { meetingId: MEETING_ID, mode: "finance" },
      { meetingId: OTHER_MEETING_ID, mode: "behavioral" },
    ]);
  });
});
