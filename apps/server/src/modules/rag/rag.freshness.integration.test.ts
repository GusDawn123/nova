import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRagIndexerDb } from "../../db/rag-indexer.js";

import { createPgPool, createPgVectorStore } from "./adapters/pgvector.js";
import { chunker } from "./chunker.js";
import { ragConfig } from "./config.js";
import { createRagIndexer, type IndexerLogger } from "./indexer.js";
import type { RagHit, VectorStore } from "./ports.js";
import { createRagService, type RagService } from "./service.js";
import { MockEmbedder } from "./testing/mock-rag.js";

/**
 * Freshness exit-bar proof (playbook): from a call's `ended_at` to queryable chunks
 * in < 60s, end to end through the REAL sweeper + REAL pgvector store against the
 * LIVE local Supabase Postgres. A deterministic MOCK embedder stands in for Voyage
 * (no vendor key needed) — index-seeded unit vectors give a well-defined cosine
 * order, so the store returns hits the moment the sweeper has ingested.
 *
 * Self-skips unless SUPABASE_DB_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
 * all present (so `npm run test` stays green with the stack down). The 60s assertion
 * is an immutable exit bar — it is never weakened.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const DIMS = 1024;
const MODEL = "mock-embed-1024";
const FRESHNESS_BAR_MS = 60_000;

/** A 1024-dim vector with a single non-zero entry (aligns with MockEmbedder output). */
function unit(index: number): number[] {
  const v = Array<number>(DIMS).fill(0);
  v[index] = 1;
  return v;
}

/** MockEmbedder maps a query's single text to e0 — search with e0 to hit chunk 0. */
const QUERY_VECTOR = unit(0);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)("rag freshness (local stack)", () => {
  let pool: Pool;
  let store: VectorStore;
  let ragService: RagService;
  let admin: ReturnType<typeof createClient>;
  let userA: string;
  let meetingWithTranscript: string;
  let emptyMeeting: string;
  const userIds: string[] = [];

  const logs: {
    level: string;
    fields: Record<string, unknown>;
    msg: string;
  }[] = [];
  const logger: IndexerLogger = {
    info: (fields, msg) => logs.push({ level: "info", fields, msg }),
    error: (fields, msg) => {
      logs.push({ level: "error", fields, msg });
      // Surface a sweep failure so a red run is diagnosable.
      console.error(`[freshness] ${msg}`, fields);
    },
  };

  /** Live (non-soft-deleted) chunk count for a meeting, straight from the DB. */
  async function liveChunks(meetingId: string): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "select count(*)::int as n from chunks where meeting_id = $1 and deleted_at is null",
      [meetingId],
    );
    return r.rows[0]?.n ?? 0;
  }

  /** A meeting's `indexed_at` (null until the sweeper stamps it). */
  async function indexedAt(meetingId: string): Promise<string | null> {
    const r = await pool.query<{ indexed_at: string | null }>(
      "select indexed_at from meetings where id = $1",
      [meetingId],
    );
    return r.rows[0]?.indexed_at ?? null;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = createPgPool(process.env);
    store = createPgVectorStore({ pool, config: ragConfig });
    // Real service over the real store, but a deterministic mock embedder.
    ragService = createRagService({
      chunker,
      embedder: new MockEmbedder({ model: MODEL, dims: DIMS }),
      store,
    });
    admin = createClient(url, serviceRoleKey, noPersist);

    const a = await admin.auth.admin.createUser({
      email: `rag-fresh-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (a.error) throw new Error(`createUser(a): ${a.error.message}`);
    userA = a.data.user.id;
    userIds.push(userA);

    // A finished (ended_at set), not-yet-indexed meeting with 8 diarized finals.
    const m = await pool.query<{ id: string }>(
      "insert into meetings (user_id, title, started_at, ended_at) values ($1,$2, now(), now()) returning id",
      [userA, "Quarterly pricing call"],
    );
    meetingWithTranscript = m.rows[0]?.id ?? "";
    expect(meetingWithTranscript).not.toBe("");

    for (let i = 0; i < 8; i++) {
      await pool.query(
        "insert into transcripts (meeting_id, user_id, content, speaker, ts_ms) values ($1,$2,$3,$4,$5)",
        [
          meetingWithTranscript,
          userA,
          `Turn ${String(i)}: discussing renewal terms and the discount ladder.`,
          i % 2 === 0 ? "spk_0" : "spk_1",
          i * 1000,
        ],
      );
    }

    // A finished meeting with NO transcripts (empty-call edge case).
    const e = await pool.query<{ id: string }>(
      "insert into meetings (user_id, title, started_at, ended_at) values ($1,$2, now(), now()) returning id",
      [userA, "Empty call"],
    );
    emptyMeeting = e.rows[0]?.id ?? "";
    expect(emptyMeeting).not.toBe("");
  });

  afterAll(async () => {
    for (const id of userIds) {
      await pool.query("delete from embeddings where user_id = $1", [id]);
      await pool.query("delete from chunks where user_id = $1", [id]);
      await pool.query("delete from transcripts where user_id = $1", [id]);
      await pool.query("delete from meetings where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  it(
    "indexes a finished meeting and makes it queryable within the freshness bar",
    async () => {
      const indexer = createRagIndexer({
        ragService,
        db: createRagIndexerDb(),
        logger,
        config: { sweepIntervalMs: 500, sweepBatchSize: 5 },
      });

      const start = Date.now();
      indexer.start();

      let hits: RagHit[] = [];
      let elapsed = -1;
      const deadline = start + FRESHNESS_BAR_MS;
      while (Date.now() < deadline) {
        hits = await store.search(userA, {
          vector: QUERY_VECTOR,
          text: "",
          model: MODEL,
          k: ragConfig.kLive,
        });
        if (hits.length > 0) {
          elapsed = Date.now() - start;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      indexer.stop();

      expect(hits.length).toBeGreaterThan(0);
      // Immutable exit bar: chunks queryable in < 60s from call end.
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(FRESHNESS_BAR_MS);
      console.log(
        `[freshness] meeting queryable ${String(elapsed)}ms after ended_at (500ms sweep)`,
      );

      // indexed_at was stamped by the same sweep.
      expect(await indexedAt(meetingWithTranscript)).not.toBeNull();
    },
    FRESHNESS_BAR_MS + 5_000,
  );

  it("re-sweep is idempotent — no duplicate live chunks", async () => {
    const before = await liveChunks(meetingWithTranscript);
    expect(before).toBeGreaterThan(0);

    // Force the meeting back into the backlog and sweep once more. Idempotent
    // ingest soft-deletes the old generation and inserts fresh, so the LIVE count
    // is unchanged (no duplicates surface to search).
    await pool.query("update meetings set indexed_at = null where id = $1", [
      meetingWithTranscript,
    ]);
    const indexer = createRagIndexer({
      ragService,
      db: createRagIndexerDb(),
      logger,
    });
    const indexed = await indexer.sweepOnce();
    expect(indexed).toBeGreaterThanOrEqual(1);

    expect(await liveChunks(meetingWithTranscript)).toBe(before);
    expect(await indexedAt(meetingWithTranscript)).not.toBeNull();
  });

  it("stamps indexed_at with zero chunks for an empty-transcript meeting", async () => {
    const indexer = createRagIndexer({
      ragService,
      db: createRagIndexerDb(),
      logger,
    });
    await indexer.sweepOnce();

    expect(await indexedAt(emptyMeeting)).not.toBeNull();
    expect(await liveChunks(emptyMeeting)).toBe(0);
  });
});
