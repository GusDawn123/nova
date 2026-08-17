import { describe, expect, it, vi } from "vitest";

import type { MeteringLogger, UsageEventInput, UsageKind } from "./ports.js";
import { createMeteringService, type MeteringServiceDeps } from "./service.js";

/**
 * MeteringService unit tests (adr-0007 §2/§4/§5):
 *  - record() prices then inserts;
 *  - record() NEVER throws — a DB failure is error-logged (ids only) and swallowed;
 *  - meterFor() maps a llm UsageEntry onto a priced ledger insert (attribution
 *    stamped), fire-and-forget, never throwing even when the DB throws;
 *  - usedInPeriod() windows on the rolling period via the injected now();
 *  - spendTodayUsd() windows on UTC midnight via the injected now().
 */

/** Returns the logger AND its mock fns as standalone consts (referencing an object
 * method in an assertion trips eslint's unbound-method rule; a local const does not). */
function spyLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger: MeteringLogger = { info, warn, error };
  return { logger, info, warn, error };
}

type InsertFn = (
  e: UsageEventInput & { costEstimateUsd: number },
) => Promise<void>;
type SumAmountFn = (u: string, k: UsageKind, s: Date) => Promise<number>;
type SumCostFn = (s: Date) => Promise<number>;

/** A capturing fake DB. `insert` records the priced event; sums return canned values. */
function fakeDb() {
  const inserts: Array<UsageEventInput & { costEstimateUsd: number }> = [];
  const insert = vi.fn<InsertFn>((e) => {
    inserts.push(e);
    return Promise.resolve();
  });
  const sumAmountForUser = vi.fn<SumAmountFn>(() => Promise.resolve(0));
  const sumCostSince = vi.fn<SumCostFn>(() => Promise.resolve(0));
  const db: MeteringServiceDeps["db"] = {
    insert,
    sumAmountForUser,
    sumCostSince,
  };
  return { inserts, insert, sumAmountForUser, sumCostSince, db };
}

/** A DB whose insert always rejects (the swallow-and-continue posture case). */
function throwingDb(): MeteringServiceDeps["db"] {
  return {
    insert: vi.fn<InsertFn>(() => Promise.reject(new Error("db down"))),
    sumAmountForUser: vi.fn<SumAmountFn>(() => Promise.resolve(0)),
    sumCostSince: vi.fn<SumCostFn>(() => Promise.resolve(0)),
  };
}

describe("record()", () => {
  it("prices then inserts the event", async () => {
    const { logger, error } = spyLogger();
    const { inserts, db } = fakeDb();
    const svc = createMeteringService({ db, logger });

    await svc.record({
      userId: "u1",
      meetingId: "m1",
      vendor: "openai",
      kind: "llm_tokens",
      model: "gpt-5.6-terra",
      amount: 1500,
      inputAmount: 1000,
      outputAmount: 500,
    });

    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row?.vendor).toBe("openai");
    expect(row?.userId).toBe("u1");
    // 1000/1e6*2.00 + 500/1e6*12.00 = 0.00800
    expect(row?.costEstimateUsd).toBeCloseTo(0.008, 10);
    expect(error).not.toHaveBeenCalled();
  });

  it("NEVER throws when the DB insert fails — logs error (ids only) + continues", async () => {
    const { logger, error } = spyLogger();
    const svc = createMeteringService({ db: throwingDb(), logger });

    await expect(
      svc.record({
        userId: "u1",
        vendor: "assemblyai",
        kind: "stt_seconds",
        amount: 60,
      }),
    ).resolves.toBeUndefined();

    // ids/dimensions only — no content, no secrets (RULES §6).
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "u1",
        kind: "stt_seconds",
        vendor: "assemblyai",
      }),
      expect.any(String),
    );
  });
});

describe("meterFor()", () => {
  it("maps a llm UsageEntry onto a priced ledger insert with attribution", async () => {
    const { logger } = spyLogger();
    const { inserts, insert, db } = fakeDb();
    const svc = createMeteringService({ db, logger });

    const meter = svc.meterFor("user-42", "meeting-7");
    meter.recordUsage({
      provider: "openai",
      model: "gpt-5.6-terra",
      inputTokens: 1000,
      outputTokens: 500,
    });

    // Fire-and-forget: wait for the insert to land.
    await vi.waitFor(() => {
      expect(insert).toHaveBeenCalledTimes(1);
    });
    const row = inserts[0];
    expect(row).toMatchObject({
      userId: "user-42",
      meetingId: "meeting-7",
      vendor: "openai",
      kind: "llm_tokens",
      amount: 1500,
      inputAmount: 1000,
      outputAmount: 500,
      model: "gpt-5.6-terra",
    });
    expect(row?.costEstimateUsd).toBeCloseTo(0.008, 10);
  });

  it("does not throw when the DB throws inside a fire-and-forget record", async () => {
    const { logger, error } = spyLogger();
    const svc = createMeteringService({ db: throwingDb(), logger });

    // recordUsage returns void and must never throw synchronously.
    expect(() => {
      svc.meterFor("u1").recordUsage({
        provider: "groq",
        model: "llama-3.1-8b-instant",
        inputTokens: 10,
        outputTokens: 20,
      });
    }).not.toThrow();

    // The swallowed insert failure is error-logged by record().
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledTimes(1);
    });
  });
});

describe("window math (injected now())", () => {
  it("usedInPeriod() sums amount from now − periodDays (default 30)", async () => {
    const { logger } = spyLogger();
    const { sumAmountForUser, db } = fakeDb();
    const fixedNow = new Date("2026-07-22T12:34:56.000Z");
    const svc = createMeteringService({ db, logger, now: () => fixedNow });

    await svc.usedInPeriod("u1", "llm_tokens");

    expect(sumAmountForUser).toHaveBeenCalledTimes(1);
    const call = sumAmountForUser.mock.calls[0];
    expect(call?.[0]).toBe("u1");
    expect(call?.[1]).toBe("llm_tokens");
    const expected = new Date(fixedNow.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(call?.[2].toISOString()).toBe(expected.toISOString());
  });

  it("spendTodayUsd() sums cost from UTC midnight of now()", async () => {
    const { logger } = spyLogger();
    const { sumCostSince, db } = fakeDb();
    // Mid-afternoon UTC → the window must start at 00:00:00Z the same date.
    const fixedNow = new Date("2026-07-22T15:07:00.000Z");
    const svc = createMeteringService({ db, logger, now: () => fixedNow });

    await svc.spendTodayUsd();

    expect(sumCostSince).toHaveBeenCalledTimes(1);
    const call = sumCostSince.mock.calls[0];
    expect(call?.[0].toISOString()).toBe("2026-07-22T00:00:00.000Z");
  });
});
