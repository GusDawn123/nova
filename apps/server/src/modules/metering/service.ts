import type { Meter, UsageEntry } from "../llm/index.js";
import { meteringConfig, type MeteringConfig } from "./config.js";
import type {
  MeteringLogger,
  MeteringService,
  UsageEventInput,
  UsageKind,
} from "./ports.js";
import { createPricer, type Pricer } from "./pricing.js";

/**
 * `createMeteringService` — the metering core (adr-0007 §2/§4/§5). It prices every
 * event and appends it to the ledger, builds the per-call llm {@link Meter} closures,
 * and answers the two aggregate questions (period usage for quotas, today's global
 * spend for the kill-switch).
 *
 * THE POSTURE (adr-0007 §1, RULES §6): `record` NEVER throws. A pricing miss is
 * already advisory-0 (pricing owns that warn); a persistence failure is logged at
 * error level (ids only — never content/secrets) and swallowed so the metered
 * operation continues. The audit invariant (separate static test) guarantees the
 * sink behind this is REAL in production wiring — swallowing failures is safe only
 * because a dropped meter is caught there, not here.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface MeteringServiceDeps {
  readonly db: {
    insert(event: UsageEventInput & { costEstimateUsd: number }): Promise<void>;
    sumAmountForUser(
      userId: string,
      kind: UsageKind,
      since: Date,
    ): Promise<number>;
    sumCostSince(since: Date): Promise<number>;
  };
  readonly logger: MeteringLogger;
  /** Price book (defaults to the plan's book). */
  readonly pricing?: Pricer;
  /** Plan limits + caps + period length (defaults to the plan's config). */
  readonly config?: MeteringConfig;
  /** Injectable clock so the window math is deterministic in tests. */
  readonly now?: () => Date;
}

export function createMeteringService(
  deps: MeteringServiceDeps,
): MeteringService {
  const { db, logger } = deps;
  const pricer: Pricer = deps.pricing ?? createPricer();
  const config: MeteringConfig = deps.config ?? meteringConfig;
  const now: () => Date = deps.now ?? (() => new Date());

  async function record(input: UsageEventInput): Promise<void> {
    // Price first (advisory; unknown → 0 + warn inside the pricer), then persist.
    const costEstimateUsd = pricer.price(input, logger);
    try {
      await db.insert({ ...input, costEstimateUsd });
    } catch (err) {
      // NEVER fail the metered operation (adr-0007 §1). Log ids + the metered
      // dimensions only — no content, no secrets (RULES §6).
      logger.error(
        {
          user_id: input.userId,
          meeting_id: input.meetingId ?? null,
          kind: input.kind,
          vendor: input.vendor,
          error: err instanceof Error ? err.message : String(err),
        },
        "metering.record_failed: usage event not persisted (operation continued)",
      );
    }
  }

  function meterFor(userId: string, meetingId?: string): Meter {
    return {
      // The llm router calls this exactly-once at `done`. Map the vendor-reported
      // {provider, model, in/out tokens} onto a priced ledger insert. Fire-and-forget
      // (void return): the router must not block or fail on metering.
      recordUsage(entry: UsageEntry): void {
        const inputTokens = entry.inputTokens ?? 0;
        const outputTokens = entry.outputTokens ?? 0;
        const input: UsageEventInput = {
          userId,
          meetingId,
          vendor: entry.provider,
          kind: "llm_tokens",
          amount: inputTokens + outputTokens,
          inputAmount: entry.inputTokens,
          outputAmount: entry.outputTokens,
          model: entry.model,
        };
        // record() already swallows its own failures; the extra .catch guards the
        // unlikely case where record itself rejects (e.g. a throwing logger) so no
        // promise floats (RULES §10 no-floating-promises).
        void record(input).catch((err: unknown) => {
          logger.error(
            {
              user_id: userId,
              meeting_id: meetingId ?? null,
              provider: entry.provider,
              error: err instanceof Error ? err.message : String(err),
            },
            "metering.meter_record_failed: llm usage not recorded",
          );
        });
      },
    };
  }

  async function usedInPeriod(
    userId: string,
    kind: UsageKind,
  ): Promise<number> {
    // Rolling window: [now − periodDays, now]. Amounts are facts (adr-0007 §4).
    const since = new Date(now().getTime() - config.periodDays * MS_PER_DAY);
    return db.sumAmountForUser(userId, kind, since);
  }

  async function spendTodayUsd(): Promise<number> {
    // UTC calendar day: from 00:00:00 UTC today (adr-0007 §5).
    const current = now();
    const since = new Date(
      Date.UTC(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate(),
      ),
    );
    return db.sumCostSince(since);
  }

  return { record, meterFor, usedInPeriod, spendTodayUsd };
}
