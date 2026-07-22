import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EmbeddedChunk, RagSource, VectorStore } from "../ports.js";
import { createPgPool, createPgVectorStore } from "./pgvector.js";

/**
 * pgvector adapter integration proof — runs against the LIVE local Supabase
 * Postgres (adr-0005 §4 direct `pg` path). Self-skips unless SUPABASE_DB_URL +
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are all present (so `npm run test`
 * stays green with the stack down). Users are minted via the admin API (they must
 * exist in auth.users for the profiles FK); sources + assertions run over the same
 * `pg` pool the adapter uses. Hand-built 1024-dim unit vectors give a deterministic
 * cosine order with NO vendor key.
 *
 * Covers: replaceSource inserts; idempotent re-replace (old rows soft-deleted, one
 * live generation); semantic leg returns the nearest neighbor first; full-text leg
 * rescues an exact rare token past the semantic candidate cut; RRF fuses (a
 * both-legs doc outranks single-leg); cross-user isolation (B sees none of A's);
 * soft-deleted chunks never returned.
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey);

const MODEL = "test-embed-1024";
const DIMS = 1024;

/** A 1024-dim vector with the given sparse (index → value) entries, rest zero. */
function sparse(entries: [number, number][]): number[] {
  const v = Array<number>(DIMS).fill(0);
  for (const [i, x] of entries) v[i] = x;
  return v;
}

/** The deterministic corpus. Cosine-to-e0 order: C1(1.0) > C4(0.98) > C2(0.8) > C3(0). */
const CORPUS: EmbeddedChunk[] = [
  {
    content: "alpha unique nearest neighbor",
    header: "Doc: test",
    chunkIndex: 0,
    tokenCount: 4,
    embedding: sparse([[0, 1]]),
    model: MODEL,
    dims: DIMS,
  },
  {
    content: "beta secondary passage",
    header: "Doc: test",
    chunkIndex: 1,
    tokenCount: 3,
    embedding: sparse([
      [0, 0.8],
      [1, 0.6],
    ]),
    model: MODEL,
    dims: DIMS,
  },
  {
    content: "gamma distant XK-9930 part number record",
    header: "Doc: test",
    chunkIndex: 2,
    tokenCount: 6,
    embedding: sparse([[1, 1]]),
    model: MODEL,
    dims: DIMS,
  },
  {
    content: "delta combined XK-9930 part number entry",
    header: "Doc: test",
    chunkIndex: 3,
    tokenCount: 6,
    embedding: sparse([
      [0, 0.98],
      [7, 0.199],
    ]),
    model: MODEL,
    dims: DIMS,
  },
];

/** Query vector aligned with e0 — nearest to C1, then C4, C2, C3. */
const Q = sparse([[0, 1]]);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)("pgvector store (local stack)", () => {
  let pool: Pool;
  let store: VectorStore;
  let admin: ReturnType<typeof createClient>;
  let userA: string;
  let userB: string;
  let docA: string;
  const userIds: string[] = [];

  /** Live (non-soft-deleted) chunk count for a source, straight from the DB. */
  async function liveChunks(contextDocId: string): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "select count(*)::int as n from chunks where context_doc_id = $1 and deleted_at is null",
      [contextDocId],
    );
    return r.rows[0]?.n ?? 0;
  }

  /** Total chunk count for a source, including soft-deleted. */
  async function totalChunks(contextDocId: string): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "select count(*)::int as n from chunks where context_doc_id = $1",
      [contextDocId],
    );
    return r.rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = createPgPool(process.env);
    // Small candidate cut (2) so the full-text leg is the ONLY way C3 (far
    // semantically) can surface — that isolates the fts contribution.
    store = createPgVectorStore({ pool, config: { candidatesPerLeg: 2, rrfK: 50 } });
    admin = createClient(url, serviceRoleKey, noPersist);

    const a = await admin.auth.admin.createUser({
      email: `pgv-a-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (a.error) throw new Error(`createUser(a): ${a.error.message}`);
    userA = a.data.user.id;
    userIds.push(userA);

    const b = await admin.auth.admin.createUser({
      email: `pgv-b-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (b.error) throw new Error(`createUser(b): ${b.error.message}`);
    userB = b.data.user.id;
    userIds.push(userB);

    const doc = await pool.query<{ id: string }>(
      "insert into context_docs (user_id, title, content) values ($1, $2, $3) returning id",
      [userA, "A test doc", "source text"],
    );
    docA = doc.rows[0]?.id ?? "";
    expect(docA).not.toBe("");
  });

  afterAll(async () => {
    for (const id of userIds) {
      await pool.query("delete from embeddings where user_id = $1", [id]);
      await pool.query("delete from chunks where user_id = $1", [id]);
      await pool.query("delete from context_docs where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  const sourceA = (): RagSource => ({ kind: "context_doc", contextDocId: docA });

  it("[insert] replaceSource inserts the whole corpus live", async () => {
    await store.replaceSource(userA, sourceA(), CORPUS);
    expect(await liveChunks(docA)).toBe(CORPUS.length);
  });

  it("[idempotent] re-replace soft-deletes the old generation, one live set", async () => {
    await store.replaceSource(userA, sourceA(), CORPUS);
    // Gen 1 (from the previous test) is now soft-deleted; gen 2 is live.
    expect(await liveChunks(docA)).toBe(CORPUS.length);
    expect(await totalChunks(docA)).toBe(CORPUS.length * 2);
  });

  it("[semantic] returns the nearest neighbor first (empty text → semantic only)", async () => {
    const hits = await store.search(userA, { vector: Q, text: "", model: MODEL, k: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("alpha unique nearest");
    expect(hits[0]?.contextDocId).toBe(docA);
    expect(hits[0]?.meetingId).toBeNull();
  });

  it("[full-text] surfaces an exact rare token past the semantic candidate cut", async () => {
    // Q keeps C3 out of the semantic top-2 (it's cosine-0), so its presence in the
    // results can ONLY come from the fts leg matching "XK-9930".
    const hits = await store.search(userA, {
      vector: Q,
      text: "XK-9930",
      model: MODEL,
      k: 10,
    });
    const contents = hits.map((h) => h.content);
    expect(contents.some((c) => c.includes("gamma distant"))).toBe(true);
  });

  it("[rrf] a doc matching BOTH legs outranks single-leg matches", async () => {
    const hits = await store.search(userA, {
      vector: Q,
      text: "XK-9930",
      model: MODEL,
      k: 10,
    });
    // C4 ("delta combined") is both near-semantic AND holds the token → top.
    expect(hits[0]?.content).toContain("delta combined");
  });

  it("[isolation] user B's search sees zero of A's corpus", async () => {
    const hits = await store.search(userB, { vector: Q, text: "XK-9930", model: MODEL, k: 10 });
    expect(hits).toHaveLength(0);
  });

  it("[soft-delete] a soft-deleted chunk is never returned", async () => {
    // Soft-delete C1 (the nearest) directly; the next nearest must take its place.
    await pool.query(
      "update chunks set deleted_at = now() where context_doc_id = $1 and content = $2 and deleted_at is null",
      [docA, "alpha unique nearest neighbor"],
    );
    const hits = await store.search(userA, { vector: Q, text: "", model: MODEL, k: 10 });
    const contents = hits.map((h) => h.content);
    expect(contents.some((c) => c.includes("alpha unique nearest"))).toBe(false);
    expect(hits[0]?.content).toContain("delta combined");
  });
});
