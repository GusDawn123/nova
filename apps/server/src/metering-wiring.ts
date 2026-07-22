import type { FastifyInstance } from "fastify";

import {
  isUsageEventsConfigured,
  usageEventsDbFromEnv,
} from "./db/usage-events.js";
import {
  createMeteringService,
  type MeteringService,
} from "./modules/metering/index.js";
import type { VoyageUsageLog } from "./modules/rag/index.js";

/**
 * Metering boot wiring (Phase 6, adr-0007) — split out of `app.ts` (RULES §2 file
 * cap). `app.ts` calls these to build the ONE process-wide metering service and
 * the Voyage usage sink; the audit test (`modules/metering/metering.audit.test.ts`)
 * statically scans BOTH files to enforce the no-unmetered-vendor-path invariant.
 */

/**
 * Build the ONE process-wide {@link MeteringService} over the `usage_events`
 * ledger when the DB is configured (`SUPABASE_DB_URL`). Undefined on a DB-less
 * boot — where no metered consumer mounts either, so no vendor path ever runs
 * without the sink (the audit invariant).
 */
export function maybeCreateMetering(
  app: FastifyInstance,
): MeteringService | undefined {
  if (!isUsageEventsConfigured(process.env)) return undefined;
  const { db } = usageEventsDbFromEnv(process.env);
  return createMeteringService({ db, logger: app.log });
}

/**
 * Map a Voyage usage line onto the metering ledger: `embedding` lines bill their
 * token count as `embedding_tokens` under the TRUE per-tier vendor model;
 * `rerank` lines bill ONE `rerank_requests` (priced $/1k requests). An
 * unattributed line (no user on the port — must not happen on wired paths, the
 * rag service always threads userId) is warn-logged and dropped, never invented.
 */
export function voyageMeteringSink(
  metering: MeteringService,
  app: FastifyInstance,
): (entry: VoyageUsageLog) => void {
  return (entry) => {
    if (entry.user_id === null) {
      app.log.warn(
        { vendor: entry.vendor, kind: entry.kind, model: entry.model },
        "metering.voyage_unattributed: usage line carried no user_id — dropped",
      );
      return;
    }
    // record() never throws (adr-0007 §1) — fire-and-forget is safe here.
    void metering.record({
      userId: entry.user_id,
      vendor: entry.vendor,
      kind: entry.kind === "rerank" ? "rerank_requests" : "embedding_tokens",
      amount: entry.kind === "rerank" ? 1 : entry.tokens,
      model: entry.model,
    });
  };
}
