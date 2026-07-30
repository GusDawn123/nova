import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createResilientPool } from "./pg-pool.js";

/**
 * [pool-resilience] `pg` emits `error` ON THE POOL for a connection that dies while
 * IDLE — a Postgres restart, a failover, a proxy idle-timeout. An `error` event with
 * no listener is re-thrown by EventEmitter, which on an unhandled async path takes
 * the whole Node process down.
 *
 * That is not theoretical here: it happened on 2026-07-25. `supabase db reset`
 * restarted the container, an idle pooled connection dropped, and the API server
 * died with `Error: Connection terminated unexpectedly`. In production the same
 * event kills every live WebSocket at once — every call in progress loses its
 * copilot mid-sentence, and a supervisor restarting the process does not bring
 * those sessions back.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The ONE module allowed to call `new Pool(` — it is what attaches the handler. */
const POOL_FACTORY = join(SRC_ROOT, "db", "pg-pool.ts");

function sourceFiles(dir: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("db/pg-pool [pool-resilience]", () => {
  it("a BARE pg Pool throws on an idle-client error (the crash being prevented)", async () => {
    // The control. Proves the next test is exercising the handler, not a pg default.
    const bare = new Pool({ connectionString: "postgresql://unused/db" });
    expect(() =>
      bare.emit("error", new Error("Connection terminated unexpectedly")),
    ).toThrow(/Connection terminated unexpectedly/);
    await bare.end();
  });

  it("createResilientPool absorbs the error and logs it instead of throwing", async () => {
    const lines: Record<string, unknown>[] = [];
    const pool = createResilientPool(
      { connectionString: "postgresql://unused/db" },
      "test-pool",
      (line) => lines.push(line),
    );

    expect(() =>
      pool.emit("error", new Error("Connection terminated unexpectedly")),
    ).not.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      pool: "test-pool",
      msg: "db.pool.idle_client_error",
    });
    await pool.end();
  });

  it("stays usable after an idle-client error (pg retires the client, not the pool)", async () => {
    const pool = createResilientPool(
      { connectionString: "postgresql://unused/db" },
      "test-pool",
      () => undefined,
    );
    pool.emit("error", new Error("Connection terminated unexpectedly"));
    // The pool object survives; only the dead client was discarded.
    expect(pool.ended).toBe(false);
    await pool.end();
  });

  /**
   * The real thing, against real Postgres: take a connection, let it go IDLE in the
   * pool, then kill it server-side the way a restart/failover does. Without the
   * handler this does not fail the assertion — it takes the whole vitest worker
   * down, which is exactly the production failure being guarded.
   */
  it.skipIf(!process.env.SUPABASE_DB_URL)(
    "survives its idle connection being terminated server-side (real Postgres)",
    async () => {
      const connectionString = process.env.SUPABASE_DB_URL;
      const logged: Record<string, unknown>[] = [];
      const pool = createResilientPool(
        { connectionString, max: 1, idleTimeoutMillis: 30_000 },
        "terminate-test",
        (line) => logged.push(line),
      );

      // Take a connection and hand it back — now it sits IDLE in the pool.
      const held = await pool.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const pid = held.rows[0]?.pid;
      expect(pid).toBeGreaterThan(0);

      // Kill it from a separate connection (a restart/failover, in miniature).
      const killer = new Pool({ connectionString });
      await killer.query("select pg_terminate_backend($1)", [pid]);
      await killer.end();

      // Let the socket close land on the pool's error path.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Reaching this line at all is the assertion: the process is still alive.
      expect(logged.map((l) => l.msg)).toContain("db.pool.idle_client_error");

      // And the pool recovered — pg discarded the dead client, next connect is fresh.
      const after = await pool.query<{ ok: number }>("select 1 as ok");
      expect(after.rows[0]?.ok).toBe(1);
      await pool.end();
    },
  );

  it("[pool-audit] NO module builds a bare `new Pool(` outside the factory", () => {
    const offenders = sourceFiles()
      .filter((f) => f !== POOL_FACTORY)
      .filter((f) => readFileSync(f, "utf8").includes("new Pool("))
      .map((f) => f.slice(SRC_ROOT.length + 1));

    // A new pool that skips the factory skips the error handler, and one dropped
    // idle connection is then a process-wide outage again.
    expect(offenders).toEqual([]);
  });
});
