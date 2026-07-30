import { describe, expect, it } from "vitest";
import { serverLiveEventSchema, type ServerLiveEvent } from "@nova/shared";

import type { SttEngine } from "../stt/ports.js";

import {
  createInMemorySessionRegistry,
  type LiveMetering,
  type LiveSttUsage,
  type TranscriptPersister,
} from "./ports.js";
import { LiveSession, type LiveSessionDeps } from "./session.js";

/**
 * [daily-cap] The global spend kill-switch at session start (adr-0007 §5):
 * tripped → typed `daily_cap_reached` + policy close BEFORE any per-user DB
 * work (ownership/quota) and before any STT vendor starts; check order is
 * concurrency → cap → ownership → quota (cheap/global before per-user).
 * In-flight sessions FINISH: there is deliberately no mid-stream cap cut.
 * Fail-open on a failing check (the seam/kill-switch logs loudly).
 */

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const BYTES_PER_SECOND = 16000 * 2;

function countingEngine(): { engine: SttEngine; starts: () => number } {
  let starts = 0;
  return {
    starts: () => starts,
    engine: {
      startSession() {
        starts += 1;
        return { onAudioFrame() {}, stop() {} };
      },
    },
  };
}

function trackingPersister(): TranscriptPersister & { ownershipCalls: number } {
  return {
    ownershipCalls: 0,
    saveFinal: () => Promise.resolve(),
    markEnded: () => Promise.resolve(),
    verifyMeetingOwnership() {
      this.ownershipCalls += 1;
      return Promise.resolve(true);
    },
  };
}

function fakeMetering(): {
  metering: LiveMetering;
  records: LiveSttUsage[];
  setCapTripped: (v: boolean) => void;
  quotaCalls: () => number;
} {
  const records: LiveSttUsage[] = [];
  let capTripped = false;
  let quotaCalls = 0;
  return {
    records,
    setCapTripped: (v) => (capTripped = v),
    quotaCalls: () => quotaCalls,
    metering: {
      recordSttSeconds(usage) {
        records.push(usage);
        return Promise.resolve();
      },
      isOverSttQuota() {
        quotaCalls += 1;
        return Promise.resolve(false);
      },
      isOverDailyCap: () => Promise.resolve(capTripped),
    },
  };
}

function makeSession(overrides: Partial<LiveSessionDeps> = {}): {
  session: LiveSession;
  sent: ServerLiveEvent[];
} {
  const sent: ServerLiveEvent[] = [];
  const session = new LiveSession({
    send: (event) => sent.push(event),
    ...overrides,
  });
  return { session, sent };
}

const startFrame = (): string =>
  JSON.stringify({ v: 1, type: "session.start", meeting_id: MEETING_ID });

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("LiveSession daily cap", () => {
  it("[daily-cap] a tripped cap refuses the start: typed error, no ownership, no vendor", async () => {
    const engine = countingEngine();
    const persister = trackingPersister();
    const m = fakeMetering();
    m.setCapTripped(true);
    const { session, sent } = makeSession({
      sttEngine: engine.engine,
      persister,
      metering: m.metering,
      userId: USER_ID,
    });

    session.handleTextMessage(startFrame());
    await flush();

    const refusal = sent.find((e) => e.type === "error");
    expect(refusal).toMatchObject({ code: "daily_cap_reached" });
    expect(() => serverLiveEventSchema.parse(refusal)).not.toThrow();
    expect(sent.some((e) => e.type === "session.ready")).toBe(false);
    // Cheap/global before per-user DB work: no ownership call, no quota call,
    // no vendor start, session torn down.
    expect(persister.ownershipCalls).toBe(0);
    expect(m.quotaCalls()).toBe(0);
    expect(engine.starts()).toBe(0);
    expect(session.disposer.disposed).toBe(true);
  });

  it("[daily-cap] the concurrency slot is released when the cap refuses a start", async () => {
    const registry = createInMemorySessionRegistry();
    const m = fakeMetering();
    m.setCapTripped(true);
    const refused = makeSession({
      registry,
      metering: m.metering,
      userId: USER_ID,
    });
    refused.session.handleTextMessage(startFrame());
    await flush();
    expect(refused.sent.find((e) => e.type === "error")).toMatchObject({
      code: "daily_cap_reached",
    });

    // The refused session's disposer freed the slot → a later (under-cap)
    // start for the same user succeeds.
    m.setCapTripped(false);
    const next = makeSession({
      registry,
      metering: m.metering,
      userId: USER_ID,
    });
    next.session.handleTextMessage(startFrame());
    await flush();
    expect(next.sent.some((e) => e.type === "session.ready")).toBe(true);
  });

  it("[daily-cap] under the cap the session proceeds normally", async () => {
    const engine = countingEngine();
    const m = fakeMetering();
    const { session, sent } = makeSession({
      sttEngine: engine.engine,
      metering: m.metering,
      userId: USER_ID,
    });
    session.handleTextMessage(startFrame());
    await flush();
    expect(sent.some((e) => e.type === "session.ready")).toBe(true);
    expect(engine.starts()).toBe(1);
    session.close();
  });

  it("[daily-cap] in-flight sessions FINISH: a cap tripping mid-call never cuts the stream", async () => {
    const engine = countingEngine();
    const m = fakeMetering();
    const { session, sent } = makeSession({
      sttEngine: engine.engine,
      metering: m.metering,
      userId: USER_ID,
      initialSttVendor: "assemblyai",
      quotaRecheckSeconds: 1,
    });
    session.handleTextMessage(startFrame());
    await flush();

    // The cap trips AFTER the session started; several recheck ticks of audio
    // later the session is still alive (only QUOTA cuts mid-stream) and its
    // usage keeps landing.
    m.setCapTripped(true);
    for (let i = 0; i < 3; i++) {
      session.handleBinaryMessage(Buffer.alloc(BYTES_PER_SECOND));
      await flush();
    }
    expect(session.disposer.disposed).toBe(false);
    expect(sent.some((e) => e.type === "error")).toBe(false);
    expect(m.records.length).toBeGreaterThanOrEqual(3);

    session.close();
  });

  it("[daily-cap] a failing cap check fails OPEN (session proceeds, logged)", async () => {
    const errorLogs: string[] = [];
    const m = fakeMetering();
    const metering: LiveMetering = {
      ...m.metering,
      isOverDailyCap: () => Promise.reject(new Error("sum backend down")),
    };
    const { session, sent } = makeSession({
      metering,
      userId: USER_ID,
      logger: { error: (_f, msg) => errorLogs.push(msg) },
    });
    session.handleTextMessage(startFrame());
    await flush();
    expect(sent.some((e) => e.type === "session.ready")).toBe(true);
    expect(errorLogs.some((m2) => m2.includes("daily_cap"))).toBe(true);
    session.close();
  });
});
