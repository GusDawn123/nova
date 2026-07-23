import { z } from "zod";

import type { Meter } from "../llm/index.js";

/**
 * `modules/metering` port contracts (adr-0007, docs/DESIGN/metering.md §Module
 * anatomy). These interfaces are LOCKED — Tasks 2–5 compile against them verbatim.
 * The module has no `process.env` reads and imports no vendor SDK; env + pool wiring
 * lives in app.ts (RULES §2).
 */

/**
 * The metered-unit families. Mirrors the `usage_events.kind` CHECK constraint (the
 * DB is the source of truth for the closed set); a new kind is a deliberate migration
 * on both sides. `db/schema.ts` re-declares the same values as `usageKindDbSchema`
 * (the DB layer does not import module code — RULES §2).
 */
export const usageKindSchema = z.enum([
  "llm_tokens",
  "stt_seconds",
  "embedding_tokens",
  "rerank_requests",
]);
export type UsageKind = z.infer<typeof usageKindSchema>;

/**
 * One metered event as the callers describe it (before pricing). `amount` is the
 * billed quantity in the unit implied by `kind` (tokens | seconds | requests);
 * `inputAmount`/`outputAmount` are the llm token split (omitted otherwise). This is
 * an IN-PROCESS input constructed by our own code (the meterFor closure, the live
 * session), not an external wire boundary, so it is a plain typed input — the DB READ
 * boundary is what gets zod-parsed, in the adapter. The zod schema is provided for
 * defensive validation where a caller wants it.
 */
export const usageEventInputSchema = z.object({
  userId: z.string(),
  meetingId: z.string().optional(),
  vendor: z.string(),
  kind: usageKindSchema,
  amount: z.number(),
  inputAmount: z.number().optional(),
  outputAmount: z.number().optional(),
  model: z.string().optional(),
});
/** Readonly so the shape matches the locked interface field-for-field. */
export type UsageEventInput = Readonly<z.infer<typeof usageEventInputSchema>>;

/**
 * The ledger persistence port (adr-0007 §1). Implemented by the pg-Pool adapter in
 * `apps/server/src/db/usage-events.ts`. `insert` takes the priced event; the two
 * sums are SQL aggregates (period-per-user for quotas, global-since for the daily
 * kill-switch).
 */
export interface UsageEventsDb {
  /** Append one priced usage row (service-role write). */
  insert(event: UsageEventInput & { costEstimateUsd: number }): Promise<void>;
  /** Σ amount for one user + kind since `since` (inclusive) — the quota window. */
  sumAmountForUser(
    userId: string,
    kind: UsageKind,
    since: Date,
  ): Promise<number>;
  /** Σ cost_estimate_usd across ALL users since `since` (inclusive) — kill-switch. */
  sumCostSince(since: Date): Promise<number>;
}

/**
 * Structured log sink (Fastify `app.log` shape) — only ids/counts ever cross it,
 * never transcript content or secrets (RULES §6). `warn` carries the unknown-price
 * signal; `error` carries a swallowed metering-write failure.
 */
export interface MeteringLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/**
 * The metering service (adr-0007 §2/§4/§5). `record` prices then inserts and NEVER
 * throws — a persistence failure logs at error level and the metered operation
 * continues (the fire-and-forget posture; the audit invariant guarantees the sink is
 * real in production). `meterFor` builds the per-call llm {@link Meter} closure that
 * stamps user/meeting attribution. `usedInPeriod` is the rolling-period amount sum
 * (quota); `spendTodayUsd` is the UTC-day global cost sum (kill-switch).
 */
export interface MeteringService {
  record(input: UsageEventInput): Promise<void>;
  meterFor(userId: string, meetingId?: string): Meter;
  usedInPeriod(userId: string, kind: UsageKind): Promise<number>;
  spendTodayUsd(): Promise<number>;
}
