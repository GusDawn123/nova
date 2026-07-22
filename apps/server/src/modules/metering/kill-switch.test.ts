import { describe, expect, it, vi } from "vitest";

import { meteringConfigSchema } from "./config.js";
import { createKillSwitch } from "./kill-switch.js";
import type { MeteringLogger } from "./ports.js";

/**
 * Kill-switch unit tests (adr-0007 §5): trips at/over `dailyGlobalCapUsd` on
 * ESTIMATED dollars (what estimates are for); fires exactly ONE error-level
 * `metering.daily_cap_tripped` alert per UTC day (dedupe on the injected
 * clock); FAILS OPEN with a loud, distinct error log when the sum query fails
 * (an infra outage of the aggregate must not brick the product).
 */

function spyLogger() {
  const error = vi.fn();
  const logger: MeteringLogger = { info: vi.fn(), warn: vi.fn(), error };
  return { logger, error };
}

const config = meteringConfigSchema.parse({ dailyGlobalCapUsd: 50 });

const trippedAlerts = (error: ReturnType<typeof vi.fn>) =>
  error.mock.calls.filter(([, msg]) => msg === "metering.daily_cap_tripped");

describe("createKillSwitch", () => {
  it("under the cap → not tripped, no alert", async () => {
    const { logger, error } = spyLogger();
    const killSwitch = createKillSwitch({
      spendTodayUsd: () => Promise.resolve(49.99),
      config,
      logger,
    });
    await expect(killSwitch.isTripped()).resolves.toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it("AT the cap → tripped (>= binds, like quotas)", async () => {
    const { logger } = spyLogger();
    const killSwitch = createKillSwitch({
      spendTodayUsd: () => Promise.resolve(50),
      config,
      logger,
    });
    await expect(killSwitch.isTripped()).resolves.toBe(true);
  });

  it("alerts exactly ONCE per UTC day, then again on the next day", async () => {
    const { logger, error } = spyLogger();
    let nowIso = "2026-07-22T20:00:00.000Z";
    const killSwitch = createKillSwitch({
      spendTodayUsd: () => Promise.resolve(75),
      config,
      logger,
      now: () => new Date(nowIso),
    });

    await killSwitch.isTripped();
    await killSwitch.isTripped();
    nowIso = "2026-07-22T23:59:59.000Z"; // same UTC day, later
    await killSwitch.isTripped();
    expect(trippedAlerts(error)).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ utc_day: "2026-07-22" }),
      "metering.daily_cap_tripped",
    );

    nowIso = "2026-07-23T00:00:01.000Z"; // the next UTC day → one new alert
    await killSwitch.isTripped();
    await killSwitch.isTripped();
    expect(trippedAlerts(error)).toHaveLength(2);
  });

  it("an untripped day never alerts, and recovery re-arms nothing early", async () => {
    const { logger, error } = spyLogger();
    let spend = 75;
    const killSwitch = createKillSwitch({
      spendTodayUsd: () => Promise.resolve(spend),
      config,
      logger,
      now: () => new Date("2026-07-22T20:00:00.000Z"),
    });
    await killSwitch.isTripped(); // alert #1
    spend = 10; // (hypothetical correction) same day, under cap
    await expect(killSwitch.isTripped()).resolves.toBe(false);
    spend = 90; // re-trips the SAME day → still just the one alert
    await killSwitch.isTripped();
    expect(trippedAlerts(error)).toHaveLength(1);
  });

  it("a failing sum FAILS OPEN with a loud, distinct error log", async () => {
    const { logger, error } = spyLogger();
    const killSwitch = createKillSwitch({
      spendTodayUsd: () => Promise.reject(new Error("aggregate down")),
      config,
      logger,
    });
    await expect(killSwitch.isTripped()).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toContain("daily_cap_check_failed");
    expect(trippedAlerts(error)).toHaveLength(0);
  });
});
