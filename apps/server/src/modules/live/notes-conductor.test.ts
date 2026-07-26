import type { ServerLiveEvent } from "@nova/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LiveNotesStore,
  LiveNotesWriteResult,
} from "../../db/live-notes.js";
import type { LlmRouter, LlmStreamEvent } from "../llm/index.js";
import { emptyLiveNotes } from "../notes/index.js";

import { notesConductorConfigSchema } from "./notes-conductor-config.js";
import {
  createLiveNotesConductor,
  type LiveNotesConductor,
} from "./notes-conductor.js";

/**
 * [notes-conductor] The loop, under fake timers with a scripted router and an
 * in-memory store.
 *
 * The load-bearing property here is the DELTA LIFECYCLE: the fold never re-reads
 * the transcript, so anything a failed fold consumed is gone for the rest of the
 * call. Every unhappy path below asserts the delta survived, by driving a second
 * fold and checking it still saw the earlier turns.
 */

/**
 * A manually-released gate, so a test can hold a fold "in flight" across timer
 * advances. Declared with a real initializer rather than `null` — a nullable
 * `let` assigned inside the Promise executor gets narrowed to `never` by TS's
 * control-flow analysis, which cannot see the executor runs synchronously.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Every prompt the scripted router was handed, newest last. */
let prompts: string[];
let events: ServerLiveEvent[];

/** One scripted response per call: a JSON string, or an Error to throw. */
function scriptedRouter(script: (string | Error)[]): LlmRouter {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(req, opts): AsyncIterable<LlmStreamEvent> {
      prompts.push(req.messages.map((m) => m.content).join("\n"));
      const next = script.shift() ?? '{"ops":[]}';
      if (next instanceof Error) throw next;
      if (opts?.signal?.aborted === true) throw new Error("aborted");
      yield { type: "token", text: next };
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

interface FakeStore extends LiveNotesStore {
  readonly writes: { rev: number; titles: string }[];
}

function fakeStore(seed: Awaited<ReturnType<LiveNotesStore["readLiveNotes"]>> = null): FakeStore {
  const writes: { rev: number; titles: string }[] = [];
  return {
    writes,
    readLiveNotes: () => Promise.resolve(seed),
    upsertLiveNotes: (input): Promise<LiveNotesWriteResult> => {
      writes.push({ rev: input.rev, titles: input.notes.title });
      return Promise.resolve({ status: "written", rev: input.rev });
    },
  };
}

const CONFIG = notesConductorConfigSchema.parse({
  foldIntervalMs: 1000,
  minUtterancesPerFold: 1,
  classifyMinTurns: 1000, // classify off unless a test lowers it
  narrativeEveryNFolds: 1000, // narrative window closed unless a test opens it
});

/** A substantive turn — the gate must fire on it. */
function turn(n: number): [string, string] {
  return [`We decided to ship milestone ${String(n)} on Friday.`, "them"];
}

function makeConductor(
  over: Partial<Parameters<typeof createLiveNotesConductor>[0]> = {},
): LiveNotesConductor {
  return createLiveNotesConductor({
    send: (e) => events.push(e),
    router: scriptedRouter([]),
    store: fakeStore(),
    userId: "user-1",
    meetingId: "meeting-1",
    meetingTitle: "Acme call",
    startedAt: "2026-07-26T10:00:00.000Z",
    config: CONFIG,
    ...over,
  });
}

function notesUpdates(): Extract<ServerLiveEvent, { type: "notes.update" }>[] {
  return events.filter(
    (e): e is Extract<ServerLiveEvent, { type: "notes.update" }> =>
      e.type === "notes.update",
  );
}

const ADD_ONE = JSON.stringify({
  ops: [{ op: "add", list: "risks", item: { text: "Budget freeze" } }],
});
const ADD_TWO = JSON.stringify({
  ops: [{ op: "add", list: "risks", item: { text: "Legal review" } }],
});

beforeEach(() => {
  vi.useFakeTimers();
  prompts = [];
  events = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("[notes-conductor] the happy path", () => {
  it("folds after the debounce, bumps rev, persists, and emits", async () => {
    const store = fakeStore();
    const conductor = makeConductor({
      router: scriptedRouter([ADD_ONE]),
      store,
    });

    conductor.onFinal(...turn(1));
    expect(notesUpdates()).toHaveLength(0); // nothing before the interval

    await vi.advanceTimersByTimeAsync(1000);

    const updates = notesUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.rev).toBe(1);
    expect(updates[0]?.notes.risks.map((r) => r.text)).toEqual(["Budget freeze"]);
    expect(updates[0]?.notes.source).toBe("live");
    expect(store.writes).toEqual([{ rev: 1, titles: "Acme call" }]);
    conductor.dispose();
  });

  it("accrues across folds — rev is monotonic and prior items survive", async () => {
    const conductor = makeConductor({
      router: scriptedRouter([ADD_ONE, ADD_TWO]),
    });

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);
    conductor.onFinal(...turn(2));
    await vi.advanceTimersByTimeAsync(1000);

    const updates = notesUpdates();
    expect(updates.map((u) => u.rev)).toEqual([1, 2]);
    expect(updates[1]?.notes.risks.map((r) => r.text)).toEqual([
      "Budget freeze",
      "Legal review",
    ]);
    conductor.dispose();
  });
});

describe("[notes-conductor] the delta lifecycle", () => {
  it("retains the delta on an LLM error — no rev bump, no write", async () => {
    const store = fakeStore();
    const conductor = makeConductor({
      router: scriptedRouter([new Error("provider down"), ADD_ONE]),
      store,
    });

    conductor.onFinal("We agreed to raise the cap to 500 seats.", "them");
    await vi.advanceTimersByTimeAsync(1000);
    expect(notesUpdates()).toHaveLength(0);
    expect(store.writes).toHaveLength(0);

    // The second fold must still SEE the turn the failed fold consumed.
    conductor.onFinal(...turn(2));
    await vi.advanceTimersByTimeAsync(1000);

    expect(notesUpdates()).toHaveLength(1);
    expect(notesUpdates()[0]?.rev).toBe(1); // rev never advanced on the failure
    expect(prompts[prompts.length - 1]).toContain("raise the cap to 500 seats");
    conductor.dispose();
  });

  it("retains the delta on a schema reject", async () => {
    const conductor = makeConductor({
      // Unparseable twice — the ladder spends its repair round and gives up.
      router: scriptedRouter(["not json at all", "still not json", ADD_ONE]),
    });

    conductor.onFinal("We agreed to raise the cap to 500 seats.", "them");
    await vi.advanceTimersByTimeAsync(1000);
    expect(notesUpdates()).toHaveLength(0);

    conductor.onFinal(...turn(2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(prompts[prompts.length - 1]).toContain("raise the cap to 500 seats");
    conductor.dispose();
  });

  it("retains the delta when every op was dropped (changed:false)", async () => {
    const store = fakeStore();
    const conductor = makeConductor({
      router: scriptedRouter([
        // An update against an id that does not exist → dropped → no change.
        JSON.stringify({
          ops: [{ op: "update", list: "risks", id: "r9", item: { text: "x" } }],
        }),
        ADD_ONE,
      ]),
      store,
    });

    conductor.onFinal("We agreed to raise the cap to 500 seats.", "them");
    await vi.advanceTimersByTimeAsync(1000);
    expect(notesUpdates()).toHaveLength(0);
    expect(store.writes).toHaveLength(0);

    conductor.onFinal(...turn(2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(prompts[prompts.length - 1]).toContain("raise the cap to 500 seats");
    conductor.dispose();
  });

  it("clears ONLY what the fold consumed — turns that arrived mid-fold survive", async () => {
    const gate = deferred();
    const router: LlmRouter = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        prompts.push(req.messages.map((m) => m.content).join("\n"));
        await gate.promise;
        yield { type: "token", text: ADD_ONE };
        yield { type: "done", usage: null };
      },
    };
    const conductor = makeConductor({ router });

    conductor.onFinal("We agreed to raise the cap to 500 seats.", "them");
    await vi.advanceTimersByTimeAsync(1000);
    // The fold is out; a new turn lands while it is in flight.
    conductor.onFinal("Also Priya will own the migration by Tuesday.", "them");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // The mid-fold turn was NOT consumed, so the next fold still carries it.
    await vi.advanceTimersByTimeAsync(1000);
    const last = prompts[prompts.length - 1] ?? "";
    expect(last).toContain("Priya will own the migration");
    expect(last).not.toContain("raise the cap to 500 seats");
    conductor.dispose();
  });
});

describe("[notes-conductor] the single in-flight latch", () => {
  it("skips an overlapping tick instead of running two folds at once", async () => {
    const gate = deferred();
    let calls = 0;
    const router: LlmRouter = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        calls += 1;
        await gate.promise;
        yield { type: "token", text: ADD_ONE };
        yield { type: "done", usage: null };
      },
    };
    const conductor = makeConductor({ router });

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);

    // More turns + more intervals while the first fold is still out.
    conductor.onFinal(...turn(2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1); // still exactly one — no overlap

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    conductor.dispose();
  });
});

describe("[notes-conductor] the stops", () => {
  it("stops permanently once the per-session fold budget is spent", async () => {
    const store = fakeStore();
    const conductor = makeConductor({
      config: notesConductorConfigSchema.parse({
        foldIntervalMs: 1000,
        minUtterancesPerFold: 1,
        maxFoldsPerSession: 1,
        classifyMinTurns: 1000,
        narrativeEveryNFolds: 1000,
      }),
      router: scriptedRouter([ADD_ONE, ADD_TWO]),
      store,
    });

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.writes).toHaveLength(1);

    conductor.onFinal(...turn(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.writes).toHaveLength(1); // the budget stopped the loop
    conductor.dispose();
  });

  it("stops permanently when the quota check says over", async () => {
    const store = fakeStore();
    const conductor = makeConductor({
      router: scriptedRouter([ADD_ONE]),
      store,
      isOverQuota: () => Promise.resolve(true),
    });

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.writes).toHaveLength(0);
    expect(prompts).toHaveLength(0); // stopped BEFORE any model call
    conductor.dispose();
  });

  it("fails OPEN when the quota check itself throws", async () => {
    const store = fakeStore();
    const conductor = makeConductor({
      router: scriptedRouter([ADD_ONE]),
      store,
      isOverQuota: () => Promise.reject(new Error("metering down")),
    });

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.writes).toHaveLength(1);
    conductor.dispose();
  });
});

describe("[notes-conductor] the gate", () => {
  it("skips a pure small-talk delta without spending a call", async () => {
    const conductor = makeConductor({ router: scriptedRouter([ADD_ONE]) });

    conductor.onFinal("Hey, how are you doing today?", "them");
    conductor.onFinal("Good to see you, it's been ages.", "me");
    await vi.advanceTimersByTimeAsync(5000);

    expect(prompts).toHaveLength(0);
    expect(notesUpdates()).toHaveLength(0);
    conductor.dispose();
  });

  it("force-fires on a large delta even when the gate is quiet", async () => {
    const conductor = makeConductor({
      config: notesConductorConfigSchema.parse({
        foldIntervalMs: 1000,
        minUtterancesPerFold: 1,
        maxDeltaTokens: 10, // ~40 chars — one rambling turn clears it
        classifyMinTurns: 1000,
        narrativeEveryNFolds: 1000,
      }),
      router: scriptedRouter([ADD_ONE]),
    });

    // No lexical cue anywhere, but plenty of content: the token ceiling is what
    // stops a diffuse-but-substantive stretch from being starved.
    conductor.onFinal(
      "i mean it just sort of went the way these things usually go you know how it is",
      "them",
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(prompts).toHaveLength(1);
    conductor.dispose();
  });
});

describe("[notes-conductor] hydration", () => {
  it("emits one notes.update immediately when a row already exists", async () => {
    const seeded = {
      ...emptyLiveNotes("Acme call"),
      risks: [{ id: "r7", text: "Carried over from before" }],
    };
    const conductor = makeConductor({
      store: fakeStore({
        notes: seeded,
        rev: 4,
        updatedAt: "2026-07-26T10:05:00.000Z",
      }),
    });

    await vi.advanceTimersByTimeAsync(0);

    const updates = notesUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.rev).toBe(4);
    expect(updates[0]?.notes.risks[0]?.id).toBe("r7");
    conductor.dispose();
  });

  it("continues the hydrated rev and never re-mints a hydrated id", async () => {
    const seeded = {
      ...emptyLiveNotes("Acme call"),
      risks: [{ id: "r7", text: "Carried over from before" }],
    };
    const conductor = makeConductor({
      store: fakeStore({
        notes: seeded,
        rev: 4,
        updatedAt: "2026-07-26T10:05:00.000Z",
      }),
      router: scriptedRouter([ADD_ONE]),
    });

    await vi.advanceTimersByTimeAsync(0);
    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);

    const last = notesUpdates().at(-1);
    expect(last?.rev).toBe(5);
    expect(last?.notes.risks.map((r) => r.id)).toEqual(["r7", "r8"]);
    conductor.dispose();
  });

  it("starts from empty notes when hydration fails, rather than not at all", async () => {
    const errors: string[] = [];
    const conductor = makeConductor({
      store: {
        readLiveNotes: () => Promise.reject(new Error("db down")),
        upsertLiveNotes: () =>
          Promise.resolve({ status: "written" as const, rev: 1 }),
      },
      router: scriptedRouter([ADD_ONE]),
      logger: { error: (_f, msg) => errors.push(msg) },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toContain("live.notes_conductor.hydrate_failed");

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(notesUpdates()).toHaveLength(1);
    conductor.dispose();
  });
});

describe("[notes-conductor] dispose", () => {
  it("aborts an in-flight fold and never writes on the way out", async () => {
    const gate = deferred();
    const store = fakeStore();
    const router: LlmRouter = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await gate.promise;
        yield { type: "token", text: ADD_ONE };
        yield { type: "done", usage: null };
      },
    };
    const conductor = makeConductor({ router, store });

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);

    conductor.dispose();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(100);

    expect(store.writes).toHaveLength(0);
    expect(notesUpdates()).toHaveLength(0);
  });

  it("ignores further utterances and schedules no more folds", async () => {
    const conductor = makeConductor({ router: scriptedRouter([ADD_ONE]) });
    conductor.dispose();

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(prompts).toHaveLength(0);
    expect(notesUpdates()).toHaveLength(0);
  });

  it("is idempotent", () => {
    const conductor = makeConductor();
    conductor.dispose();
    expect(() => {
      conductor.dispose();
    }).not.toThrow();
  });
});

describe("[notes-conductor] the stale-write guard", () => {
  it("does not emit a rev the reader will never see", async () => {
    const conductor = makeConductor({
      router: scriptedRouter([ADD_ONE]),
      store: {
        readLiveNotes: () => Promise.resolve(null),
        upsertLiveNotes: () => Promise.resolve({ status: "stale" as const }),
      },
    });

    conductor.onFinal(...turn(1));
    await vi.advanceTimersByTimeAsync(1000);

    expect(notesUpdates()).toHaveLength(0);
    conductor.dispose();
  });
});
