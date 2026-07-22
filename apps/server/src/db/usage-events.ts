import { Pool } from "pg";
import { z } from "zod";

import type {
  UsageEventInput,
  UsageEventsDb,
  UsageKind,
} from "../modules/metering/ports.js";

/**
 * `UsageEventsDb` over a direct `pg` Pool — the append-only metering ledger's only
 * write/aggregate seam (adr-0007 §1, same house style as `db/jobs.ts` and
 * `modules/rag/adapters/pgvector.ts`: explicit column lists, service-role/pool
 * access, results re-parsed at the boundary).
 *
 * WHY the pg Pool (not supabase-js): the two read paths are SQL `sum(...)` aggregates
 * with a `where` window — supabase-js/PostgREST cannot express a server-side `SUM`
 * without an RPC, and pulling every row to sum in JS would not scale for a billing
 * ledger. Postgres returns `numeric` as a STRING over the wire, so every aggregate is
 * coerced (`z.coerce.number()`) and `coalesce(..., 0)` guarantees a row even when the
 * window is empty.
 */

const PG_POOL_MAX = 10;
const PG_IDLE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Boundary parsing (the DB is a boundary too; RULES §1).
// ---------------------------------------------------------------------------

/** A single-cell aggregate result. `numeric` arrives as a string → coerce. */
const sumRowSchema = z.object({ total: z.coerce.number() });

// ---------------------------------------------------------------------------
// Store factory.
// ---------------------------------------------------------------------------

/** Build a {@link UsageEventsDb} over an explicit pool (pure of env). */
export function createUsageEventsDb(pool: Pool): UsageEventsDb {
  return {
    async insert(
      event: UsageEventInput & { costEstimateUsd: number },
    ): Promise<void> {
      // Explicit columns (RULES §10). meeting_id/input_amount/output_amount/model are
      // nullable — coalesce undefined to null so the positional params always bind.
      await pool.query(
        `insert into usage_events
           (user_id, meeting_id, vendor, kind, amount,
            input_amount, output_amount, model, cost_estimate_usd)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.userId,
          event.meetingId ?? null,
          event.vendor,
          event.kind,
          event.amount,
          event.inputAmount ?? null,
          event.outputAmount ?? null,
          event.model ?? null,
          event.costEstimateUsd,
        ],
      );
    },

    async sumAmountForUser(
      userId: string,
      kind: UsageKind,
      since: Date,
    ): Promise<number> {
      // Period window is inclusive of `since` (created_at >= $3); the
      // (user_id, created_at) index covers this range scan.
      const res = await pool.query(
        `select coalesce(sum(amount), 0) as total
         from usage_events
         where user_id = $1 and kind = $2 and created_at >= $3`,
        [userId, kind, since.toISOString()],
      );
      return sumRowSchema.parse(res.rows[0]).total;
    },

    async sumCostSince(since: Date): Promise<number> {
      // Global across all users; the (created_at) index covers the window.
      const res = await pool.query(
        `select coalesce(sum(cost_estimate_usd), 0) as total
         from usage_events
         where created_at >= $1`,
        [since.toISOString()],
      );
      return sumRowSchema.parse(res.rows[0]).total;
    },
  };
}

// ---------------------------------------------------------------------------
// Env factory (lazy, memoised pool — mirrors notesJobStoreFromEnv).
// ---------------------------------------------------------------------------

/** Re-parsed at this boundary (RULES §1), local to the adapter. */
const pgEnvSchema = z.object({ SUPABASE_DB_URL: z.string().url() });

/** Raised when the usage-events store is asked for on a keyless (no DB URL) boot. */
export class UsageEventsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageEventsConfigError";
  }
}

/** Build a pool from env; throws {@link UsageEventsConfigError} when unconfigured. */
export function createUsageEventsPool(
  source: NodeJS.ProcessEnv = process.env,
): Pool {
  const parsed = pgEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new UsageEventsConfigError(
      "Usage-events store is not configured: set SUPABASE_DB_URL.",
    );
  }
  return new Pool({
    connectionString: parsed.data.SUPABASE_DB_URL,
    max: PG_POOL_MAX,
    idleTimeoutMillis: PG_IDLE_TIMEOUT_MS,
  });
}

/** Presence check: is SUPABASE_DB_URL set + well-formed (so a feature can wire)? */
export function isUsageEventsConfigured(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  return pgEnvSchema.safeParse(source).success;
}

let cachedPool: Pool | undefined;

/** Lazily build + memoise the pool and wrap it as a {@link UsageEventsDb}. */
export function usageEventsDbFromEnv(source: NodeJS.ProcessEnv = process.env): {
  db: UsageEventsDb;
  pool: Pool;
} {
  cachedPool ??= createUsageEventsPool(source);
  return { db: createUsageEventsDb(cachedPool), pool: cachedPool };
}
