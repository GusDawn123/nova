import { Pool, type PoolConfig } from "pg";

/**
 * The ONE place a `pg` Pool is constructed (enforced by the `[pool-audit]` static
 * test in `pg-pool.test.ts`).
 *
 * WHY IT EXISTS: `pg` emits `error` on the POOL when a connection dies while IDLE —
 * a Postgres restart, a failover, a proxy idle-timeout. Node's EventEmitter
 * RE-THROWS an `error` event that has no listener, and on an async path that is an
 * uncaught exception: the whole process dies.
 *
 * Observed, not theorised (2026-07-25): `supabase db reset` restarted the container,
 * an idle pooled connection dropped, and the API server exited with
 * `Error: Connection terminated unexpectedly`. In production the blast radius is
 * worse than a restart — every live WebSocket dies at once, so every call in
 * progress loses its copilot mid-sentence, and a supervisor bringing the process
 * back does not bring those sessions with it.
 *
 * Attaching ANY listener is the whole fix: `pg` has already discarded the dead
 * client by the time it emits, so the pool keeps working and the next `connect()`
 * dials a fresh connection. There is nothing to retry and nothing to reset — the
 * only job here is to not be silent, and to not die.
 */

/** Pool ceiling, shared by every store (adr-0005 §4 / adr-0006). */
export const PG_POOL_MAX = 10;
/** How long an unused connection lingers before the pool closes it. */
export const PG_IDLE_TIMEOUT_MS = 30_000;

/** One structured log line. Kept as a plain callback so `db/` owes nothing to Fastify. */
export type PoolErrorLogger = (line: Record<string, unknown>) => void;

/**
 * Default sink: a structured JSON line on stderr. These pools are built lazily from
 * env and memoised at module scope, long before any request logger exists, so there
 * is no `app.log` to hand them. Callers with a real logger can pass one.
 */
const defaultLog: PoolErrorLogger = (line) => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

/**
 * Build a Pool that survives losing an idle connection. `poolName` identifies which
 * store failed in the logs (`jobs` / `usage_events` / `pgvector`) — with three pools
 * against one database, "a connection died" is not actionable without it.
 *
 * The error carries no user data (a libpq/socket message), so logging it whole does
 * not violate RULES §6.
 */
export function createResilientPool(
  config: PoolConfig,
  poolName: string,
  log: PoolErrorLogger = defaultLog,
): Pool {
  const pool = new Pool(config);
  pool.on("error", (err: Error) => {
    log({
      level: "error",
      pool: poolName,
      err: err.message,
      msg: "db.pool.idle_client_error",
    });
  });
  return pool;
}
