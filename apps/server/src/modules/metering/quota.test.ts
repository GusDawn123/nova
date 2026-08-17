import { describe, expect, it, vi } from "vitest";

import { meteringConfigSchema } from "./config.js";
import type { MeteringLogger } from "./ports.js";
import { createQuotaChecker, type PlanReader } from "./quota.js";

/**
 * Quota checker unit tests (adr-0007 §4): plan limits bind on AMOUNTS via
 * usedInPeriod; `free`/`pro` map to their config limits per kind; at-the-limit
 * counts as over (>=); an internal failure (plan read / sum) FAILS OPEN with an
 * error log — quota is enforcement, but a metering-DB blip must not take down
 * every call (the kill-switch is the spend backstop).
 */

function spyLogger() {
  const error = vi.fn();
  const logger: MeteringLogger = { info: vi.fn(), warn: vi.fn(), error };
  return { logger, error };
}

function plans(plan: "free" | "pro"): PlanReader {
  return { getPlan: () => Promise.resolve(plan) };
}

function roles(role: "developer" | "admin" | "customer" = "customer") {
  return { getRole: () => Promise.resolve(role) };
}

/** Tiny injected limits so the arithmetic is obvious. */
const config = meteringConfigSchema.parse({
  plans: {
    free: { sttSecondsPerPeriod: 60, llmTokensPerPeriod: 100 },
    pro: { sttSecondsPerPeriod: 600, llmTokensPerPeriod: 1000 },
  },
});

function usedInPeriod(value: number) {
  return vi.fn(() => Promise.resolve(value));
}

describe("createQuotaChecker", () => {
  it("under the plan limit → not over", async () => {
    const { logger } = spyLogger();
    const checker = createQuotaChecker({
      usedInPeriod: usedInPeriod(59),
      plans: plans("free"),
      roles: roles(),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "stt_seconds")).resolves.toBe(false);
  });

  it("AT the limit → over (>= binds)", async () => {
    const { logger } = spyLogger();
    const checker = createQuotaChecker({
      usedInPeriod: usedInPeriod(60),
      plans: plans("free"),
      roles: roles(),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "stt_seconds")).resolves.toBe(true);
  });

  it("the pro plan binds its own (larger) limit", async () => {
    const { logger } = spyLogger();
    const checker = createQuotaChecker({
      usedInPeriod: usedInPeriod(599),
      plans: plans("pro"),
      roles: roles(),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "stt_seconds")).resolves.toBe(false);
  });

  it("kinds bind their own limits (llm_tokens)", async () => {
    const { logger } = spyLogger();
    const used = usedInPeriod(100);
    const checker = createQuotaChecker({
      usedInPeriod: used,
      plans: plans("free"),
      roles: roles(),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "llm_tokens")).resolves.toBe(true);
    expect(used).toHaveBeenCalledWith("u1", "llm_tokens");
  });

  it("a plan-read failure FAILS OPEN with one error log", async () => {
    const { logger, error } = spyLogger();
    const checker = createQuotaChecker({
      usedInPeriod: usedInPeriod(999_999),
      plans: { getPlan: () => Promise.reject(new Error("db down")) },
      roles: roles(),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "stt_seconds")).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("a usage-sum failure FAILS OPEN with one error log", async () => {
    const { logger, error } = spyLogger();
    const checker = createQuotaChecker({
      usedInPeriod: vi.fn(() => Promise.reject(new Error("sum failed"))),
      plans: plans("free"),
      roles: roles(),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "llm_tokens")).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("a developer is metered but never refused, however far past the limit", async () => {
    // Gustavo, 2026-08-17: a dev account testing all day must not wall itself
    // out of its own product. The ledger still records (usedInPeriod is still
    // consulted); only the refusal is waived.
    const { logger } = spyLogger();
    const used = usedInPeriod(999_999);
    const checker = createQuotaChecker({
      usedInPeriod: used,
      plans: plans("free"),
      roles: roles("developer"),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "stt_seconds")).resolves.toBe(false);
    await expect(checker.isOverQuota("u1", "llm_tokens")).resolves.toBe(false);
  });

  it("an admin gets NO exemption — customer limits bind until decided otherwise", async () => {
    const { logger } = spyLogger();
    const checker = createQuotaChecker({
      usedInPeriod: usedInPeriod(60),
      plans: plans("free"),
      roles: roles("admin"),
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "stt_seconds")).resolves.toBe(true);
  });

  it("a role-read failure keeps quota's fail-open posture", async () => {
    const { logger, error } = spyLogger();
    const checker = createQuotaChecker({
      usedInPeriod: usedInPeriod(999_999),
      plans: plans("free"),
      roles: { getRole: () => Promise.reject(new Error("db down")) },
      config,
      logger,
    });
    await expect(checker.isOverQuota("u1", "stt_seconds")).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
