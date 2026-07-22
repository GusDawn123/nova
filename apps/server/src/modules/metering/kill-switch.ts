import { meteringConfig, type MeteringConfig } from "./config.js";
import type { MeteringLogger, MeteringService } from "./ports.js";

/**
 * The global daily spend kill-switch (adr-0007 §5): `spendTodayUsd() >=
 * dailyGlobalCapUsd` refuses NEW live sessions and NEW notes-job claims while
 * in-flight work finishes. Runs on ESTIMATED dollars — the order-of-magnitude
 * circuit breaker estimates exist for; quotas (amounts) stay the per-user law.
 *
 * ALERTING: crossing the cap fires exactly ONE error-level
 * `metering.daily_cap_tripped` log per UTC day per instance (the alert seam —
 * real paging is ops-later). The dedupe day comes from the injected clock so
 * tests drive it deterministically; the wiring memoises one instance per
 * process so the per-day guarantee holds process-wide.
 *
 * FAIL-OPEN (consistent with the quota posture, ratified Task 3): a failing sum
 * query logs LOUDLY (`metering.daily_cap_check_failed`) and reports not-tripped
 * — an infra outage of the aggregate must not brick the product; the cap
 * protects against runaway aggregate spend, not against a broken DB.
 */

export interface KillSwitch {
  /** true = today's global estimated spend is AT or OVER the daily cap. */
  isTripped(): Promise<boolean>;
}

export interface KillSwitchDeps {
  /** The UTC-day global cost sum — `MeteringService.spendTodayUsd`. */
  readonly spendTodayUsd: MeteringService["spendTodayUsd"];
  readonly config?: MeteringConfig;
  readonly logger: MeteringLogger;
  /** Injectable clock for the once-per-UTC-day alert dedupe. */
  readonly now?: () => Date;
}

export function createKillSwitch(deps: KillSwitchDeps): KillSwitch {
  const { spendTodayUsd, logger } = deps;
  const config = deps.config ?? meteringConfig;
  const now = deps.now ?? ((): Date => new Date());
  /** The UTC day ("YYYY-MM-DD") the alert last fired for; null = never. */
  let lastAlertDay: string | null = null;

  return {
    async isTripped(): Promise<boolean> {
      let spend: number;
      try {
        spend = await spendTodayUsd();
      } catch (err) {
        logger.error(
          {
            cap_usd: config.dailyGlobalCapUsd,
            error: err instanceof Error ? err.message : String(err),
          },
          "metering.daily_cap_check_failed: allowing (fail-open)",
        );
        return false;
      }
      const tripped = spend >= config.dailyGlobalCapUsd;
      if (tripped) {
        const utcDay = now().toISOString().slice(0, 10);
        if (utcDay !== lastAlertDay) {
          lastAlertDay = utcDay;
          logger.error(
            {
              spend_usd: spend,
              cap_usd: config.dailyGlobalCapUsd,
              utc_day: utcDay,
            },
            "metering.daily_cap_tripped",
          );
        }
      }
      return tripped;
    },
  };
}
