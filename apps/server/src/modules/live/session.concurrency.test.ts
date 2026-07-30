import { describe, expect, it } from "vitest";
import { serverLiveEventSchema, type ServerLiveEvent } from "@nova/shared";

import type { SttEngine } from "../stt/ports.js";

import {
  createInMemorySessionRegistry,
  type TranscriptPersister,
} from "./ports.js";
import { LiveSession, type LiveSessionDeps } from "./session.js";

/**
 * [concurrency] ONE live session per user (Phase 6, adr-0007 §6): an in-memory
 * registry behind a live-local port; the second `session.start` for the same
 * user is refused with the typed `concurrent_session` error + policy close
 * BEFORE any ownership/quota/vendor work (cheapest check first). The slot
 * releases exactly-once on disposal, so a later start succeeds; other users are
 * unaffected. Multi-instance claim is the logged opener — single-instance
 * posture is the deployment law.
 */

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";

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

describe("createInMemorySessionRegistry", () => {
  it("[concurrency] one slot per user; release frees it; users independent", () => {
    const registry = createInMemorySessionRegistry();
    expect(registry.acquire(USER_A)).toBe(true);
    expect(registry.acquire(USER_A)).toBe(false); // second claim loses
    expect(registry.acquire(USER_B)).toBe(true); // other users unaffected
    registry.release(USER_A);
    expect(registry.acquire(USER_A)).toBe(true); // freed slot reclaimable
    // Releasing twice (or a never-held user) is a harmless no-op.
    registry.release(USER_B);
    registry.release(USER_B);
    expect(registry.acquire(USER_B)).toBe(true);
  });
});

describe("LiveSession concurrency cap", () => {
  it("[concurrency] two simultaneous starts, same user → exactly one wins, deterministically", async () => {
    const registry = createInMemorySessionRegistry();
    const engine = countingEngine();
    const persister = trackingPersister();

    const first = makeSession({
      registry,
      userId: USER_A,
      persister,
      sttEngine: engine.engine,
    });
    const second = makeSession({
      registry,
      userId: USER_A,
      persister,
      sttEngine: engine.engine,
    });

    // Both frames land before either async start settles — the synchronous
    // registry claim decides the winner without any sleeps.
    first.session.handleTextMessage(startFrame());
    second.session.handleTextMessage(startFrame());
    await flush();

    expect(first.sent.some((e) => e.type === "session.ready")).toBe(true);

    const refusal = second.sent.find((e) => e.type === "error");
    expect(refusal).toMatchObject({ code: "concurrent_session" });
    expect(() => serverLiveEventSchema.parse(refusal)).not.toThrow();
    expect(second.sent.some((e) => e.type === "session.ready")).toBe(false);
    expect(second.session.disposer.disposed).toBe(true);

    // The loser was refused BEFORE ownership/vendor work: exactly one ownership
    // check (the winner's) and exactly one engine start.
    expect(persister.ownershipCalls).toBe(1);
    expect(engine.starts()).toBe(1);
  });

  it("[concurrency] disposal releases the slot exactly once → a later start succeeds", async () => {
    const registry = createInMemorySessionRegistry();

    const first = makeSession({ registry, userId: USER_A });
    first.session.handleTextMessage(startFrame());
    await flush();
    expect(first.sent.some((e) => e.type === "session.ready")).toBe(true);

    first.session.close();
    first.session.close(); // idempotent disposal must not double-release

    const third = makeSession({ registry, userId: USER_A });
    third.session.handleTextMessage(startFrame());
    await flush();
    expect(third.sent.some((e) => e.type === "session.ready")).toBe(true);
  });

  it("[concurrency] a refused start does NOT release the winner's slot", async () => {
    const registry = createInMemorySessionRegistry();

    const winner = makeSession({ registry, userId: USER_A });
    winner.session.handleTextMessage(startFrame());
    await flush();

    const loser = makeSession({ registry, userId: USER_A });
    loser.session.handleTextMessage(startFrame());
    await flush();
    expect(loser.sent.find((e) => e.type === "error")).toMatchObject({
      code: "concurrent_session",
    });

    // The loser's teardown must not free the WINNER's slot: a fresh same-user
    // start is still refused while the winner lives.
    const another = makeSession({ registry, userId: USER_A });
    another.session.handleTextMessage(startFrame());
    await flush();
    expect(another.sent.find((e) => e.type === "error")).toMatchObject({
      code: "concurrent_session",
    });
  });

  it("[concurrency] different users start concurrently without interference", async () => {
    const registry = createInMemorySessionRegistry();

    const a = makeSession({ registry, userId: USER_A });
    const b = makeSession({ registry, userId: USER_B });
    a.session.handleTextMessage(startFrame());
    b.session.handleTextMessage(startFrame());
    await flush();

    expect(a.sent.some((e) => e.type === "session.ready")).toBe(true);
    expect(b.sent.some((e) => e.type === "session.ready")).toBe(true);
  });

  it("[concurrency] no registry wired → unchanged behavior (keyless posture)", async () => {
    const a = makeSession({ userId: USER_A });
    const b = makeSession({ userId: USER_A });
    a.session.handleTextMessage(startFrame());
    b.session.handleTextMessage(startFrame());
    await flush();
    expect(a.sent.some((e) => e.type === "session.ready")).toBe(true);
    expect(b.sent.some((e) => e.type === "session.ready")).toBe(true);
  });
});
