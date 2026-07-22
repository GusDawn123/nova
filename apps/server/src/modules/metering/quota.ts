import { meteringConfig, type MeteringConfig, type PlanId } from "./config.js";
import type { MeteringLogger, MeteringService, UsageKind } from "./ports.js";

/**
 * Plan-quota checker (adr-0007 §4): quotas run on AMOUNTS (tokens/seconds — the
 * facts), never on dollar estimates. `profiles.plan` picks the config limits;
 * `usedInPeriod` supplies the rolling-window sum. At-the-limit counts as over
 * (`>=`) so a spent quota refuses the NEXT unit of work.
 *
 * FAIL-OPEN posture (my Task-3 decision, documented in the report): an internal
 * failure (plan read / usage sum) logs at error level and reports NOT over —
 * quota is enforcement, but a metering-DB blip must not refuse every call on the
 * platform; the global daily kill-switch (Task 4) is the spend backstop, and the
 * live session's ownership guard already fails CLOSED on the primary DB path.
 */

/** The quota-bearing kinds (plan limits exist only for these). */
export type QuotaKind = Extract<UsageKind, "stt_seconds" | "llm_tokens">;

/** User-scoped plan lookup — implemented by `db/plans.ts` (explicit columns). */
export interface PlanReader {
  getPlan(userId: string): Promise<PlanId>;
}

export interface QuotaChecker {
  /** true = the user is AT or OVER their plan's limit for `kind`. */
  isOverQuota(userId: string, kind: QuotaKind): Promise<boolean>;
}

export interface QuotaCheckerDeps {
  /** The rolling-window amount sum — `MeteringService.usedInPeriod`. */
  readonly usedInPeriod: MeteringService["usedInPeriod"];
  readonly plans: PlanReader;
  readonly config?: MeteringConfig;
  readonly logger: MeteringLogger;
}

/** The config limit for one plan + kind. */
function limitFor(
  config: MeteringConfig,
  plan: PlanId,
  kind: QuotaKind,
): number {
  const limits = config.plans[plan];
  return kind === "stt_seconds"
    ? limits.sttSecondsPerPeriod
    : limits.llmTokensPerPeriod;
}

export function createQuotaChecker(deps: QuotaCheckerDeps): QuotaChecker {
  const { usedInPeriod, plans, logger } = deps;
  const config = deps.config ?? meteringConfig;

  return {
    async isOverQuota(userId: string, kind: QuotaKind): Promise<boolean> {
      try {
        const [plan, used] = await Promise.all([
          plans.getPlan(userId),
          usedInPeriod(userId, kind),
        ]);
        return used >= limitFor(config, plan, kind);
      } catch (err) {
        // Fail OPEN (see module header). Ids/kind only — never content (RULES §6).
        logger.error(
          {
            user_id: userId,
            kind,
            error: err instanceof Error ? err.message : String(err),
          },
          "metering.quota_check_failed: allowing (fail-open)",
        );
        return false;
      }
    },
  };
}
